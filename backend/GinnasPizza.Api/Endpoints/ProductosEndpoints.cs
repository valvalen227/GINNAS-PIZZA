using GinnasPizza.Api.Contracts;
using GinnasPizza.Api.Data;
using GinnasPizza.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Endpoints;

public static class ProductosEndpoints
{
    private const int MaxImagen = 4_000_000;

    public static WebApplication MapProductos(this WebApplication app)
    {
        // Catálogo público: solo productos disponibles y sin recetas. Con ?todos=true (administrador) incluye todo y las recetas.
        app.MapGet("/api/productos", async (bool? todos, AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            if (todos == true)
            {
                var sesion = await http.SesionOpcionalAsync();
                if (sesion is null) return Util.Error(401, "Sesión no válida o expirada.");
                if (sesion.Rol != Roles.Administrador) return Util.Error(403, "Solo un administrador puede ver el catálogo completo.");
                var completos = await db.Productos.AsNoTracking()
                    .Include(p => p.Recetas).ThenInclude(r => r.Ingrediente)
                    .OrderBy(p => p.Id).ToListAsync(ct);
                return Results.Ok(completos.Select(p => ProductoDto.De(p, true)));
            }
            var publicos = await db.Productos.AsNoTracking().Where(p => p.Disponible).OrderBy(p => p.Id).ToListAsync(ct);
            return Results.Ok(publicos.Select(p => ProductoDto.De(p, false)));
        })
        .WithName("ListarProductos");

        app.MapPost("/api/productos", async (ProductoRequest solicitud, AppDbContext db, CancellationToken ct) =>
        {
            var producto = new Producto { FechaCreacion = DateTime.UtcNow };
            var error = await AplicarAsync(producto, solicitud, db, ct);
            if (error is not null) return error;
            db.Productos.Add(producto);
            error = await ReemplazarRecetasAsync(producto, solicitud.Recetas, db, ct);
            if (error is not null) return error;
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { return Util.Error(409, "Ya existe un producto con ese nombre."); }
            return Results.Created($"/api/productos/{producto.Id}", await CargarDtoAsync(producto.Id, db, ct));
        })
        .RequireRoles(Roles.Administrador);

        app.MapPut("/api/productos/{id:int}", async (int id, ProductoRequest solicitud, AppDbContext db, CancellationToken ct) =>
        {
            var producto = await db.Productos.Include(p => p.Recetas).FirstOrDefaultAsync(p => p.Id == id, ct);
            if (producto is null) return Util.Error(404, "El producto no existe.");
            var error = await AplicarAsync(producto, solicitud, db, ct);
            if (error is not null) return error;
            error = await ReemplazarRecetasAsync(producto, solicitud.Recetas, db, ct);
            if (error is not null) return error;
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { return Util.Error(409, "Ya existe un producto con ese nombre."); }
            return Results.Ok(await CargarDtoAsync(id, db, ct));
        })
        .RequireRoles(Roles.Administrador);

        // Reemplaza la receta de un solo tamaño (editor de recetas del módulo de inventario).
        app.MapPut("/api/productos/{id:int}/recetas", async (int id, RecetaTamanoRequest solicitud, AppDbContext db, CancellationToken ct) =>
        {
            var producto = await db.Productos.Include(p => p.Recetas).FirstOrDefaultAsync(p => p.Id == id, ct);
            if (producto is null) return Util.Error(404, "El producto no existe.");
            var error = await ReemplazarRecetasAsync(producto, [solicitud], db, ct, soloTamanosIndicados: true);
            if (error is not null) return error;
            await db.SaveChangesAsync(ct);
            return Results.Ok(await CargarDtoAsync(id, db, ct));
        })
        .RequireRoles(Roles.Administrador);

        app.MapDelete("/api/productos/{id:int}", async (int id, AppDbContext db, CancellationToken ct) =>
        {
            var producto = await db.Productos.FirstOrDefaultAsync(p => p.Id == id, ct);
            if (producto is null) return Util.Error(404, "El producto no existe.");

            var conHistorial = await db.DetallesPedido.AnyAsync(d => d.ProductoId == id, ct)
                || await db.PromocionComponentes.AnyAsync(c => c.ProductoId == id, ct);
            if (conHistorial)
            {
                producto.Disponible = false;
                await db.SaveChangesAsync(ct);
                return Results.Ok(new { desactivado = true, mensaje = "El producto conserva referencias en pedidos o promociones y se marcó como no disponible." });
            }
            db.Productos.Remove(producto); // las recetas se eliminan en cascada
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { desactivado = false, mensaje = "Producto eliminado." });
        })
        .RequireRoles(Roles.Administrador);

        return app;
    }

    private static async Task<ProductoDto?> CargarDtoAsync(int id, AppDbContext db, CancellationToken ct)
    {
        var producto = await db.Productos.AsNoTracking()
            .Include(p => p.Recetas).ThenInclude(r => r.Ingrediente)
            .FirstOrDefaultAsync(p => p.Id == id, ct);
        return producto is null ? null : ProductoDto.De(producto, true);
    }

    private static async Task<IResult?> AplicarAsync(Producto producto, ProductoRequest s, AppDbContext db, CancellationToken ct)
    {
        var nombre = Util.Limpiar(s.Nombre, 100);
        var categoria = Categorias.Normalizar(s.Categoria);
        if (nombre.Length < 2) return Util.Error(400, "El nombre es obligatorio.");
        if (categoria is null) return Util.Error(400, "La categoría debe ser Pizzas, Bebidas o Adiciones.");
        if (s.Precio < 0) return Util.Error(400, "El precio no puede ser negativo.");
        if (await db.Productos.AnyAsync(p => p.Id != producto.Id && p.Nombre.ToLower() == nombre.ToLower(), ct))
            return Util.Error(409, "Ya existe un producto con ese nombre.");

        var esPizza = categoria == Categorias.Pizzas;
        if (esPizza)
        {
            if (s.Precio <= 0 || s.PrecioMediana is not > 0 || s.PrecioFamiliar is not > 0)
                return Util.Error(400, "Las pizzas requieren un precio mayor que cero para los tamaños Personal, Mediana y Familiar.");
        }
        var imagen = s.Imagen ?? string.Empty;
        if (imagen.Length > MaxImagen) return Util.Error(400, "La imagen es demasiado grande (máximo ~3 MB).");

        producto.Nombre = nombre;
        producto.Descripcion = Util.Limpiar(s.Descripcion, 240);
        producto.Categoria = categoria;
        producto.Precio = decimal.Round(s.Precio, 2);
        producto.PrecioMediana = esPizza ? decimal.Round(s.PrecioMediana!.Value, 2) : null;
        producto.PrecioFamiliar = esPizza ? decimal.Round(s.PrecioFamiliar!.Value, 2) : null;
        producto.Disponible = s.Disponible ?? true;
        producto.Emoji = Util.Limpiar(s.Emoji, 8) is { Length: > 0 } emoji ? emoji : (categoria == Categorias.Bebidas ? "🥤" : categoria == Categorias.Adiciones ? "🧀" : "🍕");
        producto.Imagen = imagen;
        producto.Presentacion = esPizza ? string.Empty : Util.Limpiar(s.Presentacion, 40);
        return null;
    }

    /// <summary>
    /// Sincroniza las recetas con lo solicitado actualizando filas existentes (evita violar el índice único al
    /// borrar e insertar la misma clave en un mismo guardado). Con <paramref name="recetas"/> nulo no cambia nada.
    /// </summary>
    private static async Task<IResult?> ReemplazarRecetasAsync(Producto producto, List<RecetaTamanoRequest>? recetas,
        AppDbContext db, CancellationToken ct, bool soloTamanosIndicados = false)
    {
        if (recetas is null) return null;

        var deseadas = new Dictionary<(string Tamano, int IngredienteId), decimal>();
        var tamanosTocados = new HashSet<string>();
        foreach (var receta in recetas)
        {
            string tamano;
            if (producto.EsPizza)
            {
                var normalizado = Tamanos.Normalizar(receta.Tamano);
                if (normalizado is null) return Util.Error(400, "Cada receta de una pizza debe indicar el tamaño Personal, Mediana o Familiar.");
                tamano = normalizado;
            }
            else
            {
                tamano = string.Empty;
            }
            tamanosTocados.Add(tamano);

            foreach (var item in receta.Ingredientes ?? [])
            {
                if (item.Cantidad <= 0) return Util.Error(400, "Cada ingrediente de la receta debe tener una cantidad mayor que cero.");
                if (!deseadas.TryAdd((tamano, item.IngredienteId), item.Cantidad))
                    return Util.Error(400, "Un ingrediente no puede repetirse dentro de la misma receta.");
            }
        }

        var idsIngredientes = deseadas.Keys.Select(k => k.IngredienteId).Distinct().ToList();
        var existentes = await db.Ingredientes.Where(i => idsIngredientes.Contains(i.Id)).Select(i => i.Id).ToListAsync(ct);
        if (existentes.Count != idsIngredientes.Count)
            return Util.Error(400, "La receta incluye un ingrediente que no existe.");

        // Productos nuevos: no hay filas previas que sincronizar.
        var actuales = producto.Id == 0 ? [] : producto.Recetas.ToList();
        foreach (var fila in actuales)
        {
            var alcance = !soloTamanosIndicados || tamanosTocados.Contains(fila.Tamano);
            if (!alcance) continue;
            if (deseadas.Remove((fila.Tamano, fila.IngredienteId), out var cantidad)) fila.Cantidad = cantidad;
            else db.Recetas.Remove(fila);
        }
        foreach (var ((tamano, ingredienteId), cantidad) in deseadas)
        {
            producto.Recetas.Add(new Receta { Producto = producto, IngredienteId = ingredienteId, Tamano = tamano, Cantidad = cantidad });
        }
        return null;
    }
}
