using GinnasPizza.Api.Contracts;
using GinnasPizza.Api.Data;
using GinnasPizza.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Endpoints;

public static class InventarioEndpoints
{
    private static readonly string[] CategoriasIngrediente = ["Harinas", "Quesos", "Carnes", "Verduras", "Salsas", "Bebidas", "Otros"];

    public static WebApplication MapInventario(this WebApplication app)
    {
        // Cajero y mesera consultan el stock para saber qué está agotado; solo el administrador lo modifica.
        app.MapGet("/api/ingredientes", async (AppDbContext db, CancellationToken ct) =>
        {
            var lista = await db.Ingredientes.AsNoTracking().Include(i => i.Proveedor).OrderBy(i => i.Nombre).ToListAsync(ct);
            return Results.Ok(lista.Select(IngredienteDto.De));
        })
        .RequireRoles(Roles.Administrador, Roles.Cajero, Roles.Mesera)
        .WithName("ListarIngredientes");

        app.MapPost("/api/ingredientes", async (IngredienteRequest s, AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            var ingrediente = new Ingrediente();
            var error = await AplicarAsync(ingrediente, s, db, ct);
            if (error is not null) return error;
            ingrediente.StockActual = decimal.Round(s.Cantidad ?? 0, 4);
            ingrediente.Activo = s.Activo ?? true;
            db.Ingredientes.Add(ingrediente);
            if (ingrediente.StockActual > 0)
            {
                db.MovimientosInventario.Add(new MovimientoInventario
                {
                    Ingrediente = ingrediente, Tipo = "Entrada", Cantidad = ingrediente.StockActual,
                    Motivo = "Stock inicial del ingrediente", Usuario = http.Sesion().Correo
                });
            }
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { return Util.Error(409, "Ya existe un ingrediente con ese nombre."); }
            await db.Entry(ingrediente).Reference(i => i.Proveedor).LoadAsync(ct);
            return Results.Created($"/api/ingredientes/{ingrediente.Id}", IngredienteDto.De(ingrediente));
        })
        .RequireRoles(Roles.Administrador);

        app.MapPut("/api/ingredientes/{id:int}", async (int id, IngredienteRequest s, AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            var ingrediente = await db.Ingredientes.FirstOrDefaultAsync(i => i.Id == id, ct);
            if (ingrediente is null) return Util.Error(404, "El ingrediente no existe.");
            var error = await AplicarAsync(ingrediente, s, db, ct);
            if (error is not null) return error;
            if (s.Activo.HasValue) ingrediente.Activo = s.Activo.Value;

            // Solo si se envía una cantidad distinta a la actual, queda registrada como ajuste en el kardex.
            if (s.Cantidad is { } cantidadSolicitada)
            {
                var nuevoStock = decimal.Round(cantidadSolicitada, 4);
                var diferencia = nuevoStock - ingrediente.StockActual;
                if (diferencia != 0)
                {
                    ingrediente.StockActual = nuevoStock;
                    db.MovimientosInventario.Add(new MovimientoInventario
                    {
                        IngredienteId = id, Tipo = "Ajuste", Cantidad = diferencia,
                        Motivo = "Ajuste de cantidad desde la edición del ingrediente", Usuario = http.Sesion().Correo
                    });
                }
            }
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateConcurrencyException) { return Util.Error(409, "El stock cambió mientras editabas. Recarga e inténtalo de nuevo."); }
            catch (DbUpdateException) { return Util.Error(409, "Ya existe un ingrediente con ese nombre."); }
            await db.Entry(ingrediente).Reference(i => i.Proveedor).LoadAsync(ct);
            return Results.Ok(IngredienteDto.De(ingrediente));
        })
        .RequireRoles(Roles.Administrador);

        app.MapPatch("/api/ingredientes/{id:int}/estado", async (int id, EstadoActivoRequest s, AppDbContext db, CancellationToken ct) =>
        {
            var ingrediente = await db.Ingredientes.Include(i => i.Proveedor).FirstOrDefaultAsync(i => i.Id == id, ct);
            if (ingrediente is null) return Util.Error(404, "El ingrediente no existe.");
            ingrediente.Activo = s.Activa;
            ingrediente.FechaActualizacion = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(IngredienteDto.De(ingrediente));
        })
        .RequireRoles(Roles.Administrador);

        app.MapDelete("/api/ingredientes/{id:int}", async (int id, AppDbContext db, CancellationToken ct) =>
        {
            var ingrediente = await db.Ingredientes.FirstOrDefaultAsync(i => i.Id == id, ct);
            if (ingrediente is null) return Util.Error(404, "El ingrediente no existe.");

            var enRecetas = await db.Recetas.AnyAsync(r => r.IngredienteId == id, ct);
            var enPedidos = await db.MovimientosInventario.AnyAsync(m => m.IngredienteId == id && m.PedidoId != null, ct);
            if (enRecetas || enPedidos)
            {
                ingrediente.Activo = false;
                ingrediente.FechaActualizacion = DateTime.UtcNow;
                await db.SaveChangesAsync(ct);
                return Results.Ok(new { desactivado = true, mensaje = "El ingrediente tiene recetas o movimientos de pedidos asociados y se marcó como inactivo." });
            }
            // Sin relaciones de negocio: se elimina junto con su kardex manual.
            db.MovimientosInventario.RemoveRange(db.MovimientosInventario.Where(m => m.IngredienteId == id));
            db.Ingredientes.Remove(ingrediente);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { desactivado = false, mensaje = "Ingrediente eliminado." });
        })
        .RequireRoles(Roles.Administrador);

        // ── Kardex ──
        app.MapGet("/api/inventario/movimientos", async (int? limite, AppDbContext db, CancellationToken ct) =>
        {
            var lista = await db.MovimientosInventario.AsNoTracking().Include(m => m.Ingrediente)
                .OrderByDescending(m => m.Fecha).ThenByDescending(m => m.Id)
                .Take(Math.Clamp(limite ?? 300, 1, 2000)).ToListAsync(ct);
            return Results.Ok(lista.Select(MovimientoDto.De));
        })
        .RequireRoles(Roles.Administrador)
        .WithName("ListarMovimientos");

        app.MapPost("/api/inventario/movimientos", async (MovimientoRequest s, AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            var tipo = s.Tipo?.Trim();
            if (tipo is not ("Entrada" or "Salida" or "Ajuste"))
                return Util.Error(400, "El tipo de movimiento debe ser Entrada, Salida o Ajuste.");
            if (s.Cantidad < 0 || (tipo != "Ajuste" && s.Cantidad == 0))
                return Util.Error(400, "La cantidad debe ser mayor que cero.");

            var ingrediente = await db.Ingredientes.Include(i => i.Proveedor).FirstOrDefaultAsync(i => i.Id == s.IngredienteId, ct);
            if (ingrediente is null) return Util.Error(404, "El ingrediente no existe.");
            if (!ingrediente.Activo) return Util.Error(409, $"{ingrediente.Nombre} está inactivo.");

            var cantidad = decimal.Round(s.Cantidad, 4);
            decimal registrada;
            switch (tipo)
            {
                case "Entrada":
                    ingrediente.StockActual += cantidad;
                    registrada = cantidad;
                    break;
                case "Salida":
                    if (ingrediente.StockActual < cantidad)
                        return Util.Error(409, $"Existencia insuficiente de {ingrediente.Nombre}.");
                    ingrediente.StockActual -= cantidad;
                    registrada = cantidad;
                    break;
                default: // Ajuste: la cantidad indicada es el nuevo stock; se registra la diferencia con signo.
                    registrada = cantidad - ingrediente.StockActual;
                    if (registrada == 0) return Util.Error(400, "El ajuste no cambia la existencia actual.");
                    ingrediente.StockActual = cantidad;
                    break;
            }
            ingrediente.FechaActualizacion = DateTime.UtcNow;

            var movimiento = new MovimientoInventario
            {
                IngredienteId = ingrediente.Id, Tipo = tipo, Cantidad = registrada,
                Motivo = Util.Limpiar(s.Motivo, 200) is { Length: > 0 } motivo ? motivo : $"{tipo} manual",
                Usuario = http.Sesion().Correo
            };
            db.MovimientosInventario.Add(movimiento);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateConcurrencyException) { return Util.Error(409, "El stock cambió mientras se registraba el movimiento. Inténtalo de nuevo."); }

            movimiento.Ingrediente = ingrediente;
            return Results.Created($"/api/inventario/movimientos/{movimiento.Id}", new
            {
                movimiento = MovimientoDto.De(movimiento),
                ingrediente = IngredienteDto.De(ingrediente)
            });
        })
        .RequireRoles(Roles.Administrador)
        .WithName("RegistrarMovimiento");

        return app;
    }

    private static async Task<IResult?> AplicarAsync(Ingrediente ingrediente, IngredienteRequest s, AppDbContext db, CancellationToken ct)
    {
        var nombre = Util.Limpiar(s.Nombre, 100);
        var unidad = Util.Limpiar(s.Unidad, 20);
        var categoria = CategoriasIngrediente.FirstOrDefault(c => string.Equals(c, s.Categoria?.Trim(), StringComparison.OrdinalIgnoreCase)) ?? "Otros";
        if (nombre.Length < 2) return Util.Error(400, "El nombre es obligatorio.");
        if (unidad.Length == 0) return Util.Error(400, "La unidad de medida es obligatoria.");
        if ((s.Cantidad ?? 0) < 0 || s.Minimo < 0 || (s.CostoUnidad ?? 0) < 0)
            return Util.Error(400, "Cantidad, stock mínimo y costo deben ser iguales o mayores que cero.");
        if (await db.Ingredientes.AnyAsync(i => i.Id != ingrediente.Id && i.Nombre.ToLower() == nombre.ToLower(), ct))
            return Util.Error(409, "Ya existe un ingrediente con ese nombre.");
        if (s.ProveedorId is { } proveedorId && !await db.Proveedores.AnyAsync(p => p.Id == proveedorId, ct))
            return Util.Error(400, "El proveedor seleccionado no existe.");

        ingrediente.Nombre = nombre;
        ingrediente.Categoria = categoria;
        ingrediente.UnidadMedida = unidad;
        ingrediente.StockMinimo = decimal.Round(s.Minimo, 4);
        ingrediente.CostoUnitario = decimal.Round(s.CostoUnidad ?? 0, 2);
        ingrediente.ProveedorId = s.ProveedorId;
        ingrediente.FechaVencimiento = s.Vencimiento;
        ingrediente.Observaciones = Util.Limpiar(s.Observaciones, 300);
        ingrediente.FechaActualizacion = DateTime.UtcNow;
        return null;
    }
}
