using GinnasPizza.Api.Contracts;
using GinnasPizza.Api.Data;
using GinnasPizza.Api.Models;
using GinnasPizza.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Endpoints;

public static class PromocionesEndpoints
{
    private static readonly string[] Publicos = ["general", "clientes"];
    private static readonly string[] Tipos = ["precio", "fijo", "porcentaje"];

    public static WebApplication MapPromociones(this WebApplication app)
    {
        // Público: promociones vigentes. Las exclusivas para clientes registrados solo aparecen con una sesión
        // válida (cliente o personal interno, que las necesita para armar pedidos de un cliente registrado).
        // Al crear el pedido el servidor vuelve a exigir un cliente registrado para estas promociones.
        app.MapGet("/api/promociones/vigentes", async (AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            var sesion = await http.SesionOpcionalAsync();
            var autenticado = sesion is not null;
            var hoy = TiempoColombia.Hoy();
            var lista = await db.Promociones.AsNoTracking()
                .Include(p => p.Componentes).ThenInclude(c => c.Producto)
                .Where(p => p.Activa).OrderBy(p => p.Id).ToListAsync(ct);
            return Results.Ok(lista
                .Where(p => PromocionCalculadora.Vigente(p, hoy) && (p.Publico == "general" || autenticado))
                .Select(p => Mapear(p, hoy))
                .Where(p => p.PrecioFinal is not null));
        })
        .WithName("PromocionesVigentes");

        app.MapGet("/api/promociones", async (AppDbContext db, CancellationToken ct) =>
        {
            var hoy = TiempoColombia.Hoy();
            var lista = await db.Promociones.AsNoTracking()
                .Include(p => p.Componentes).ThenInclude(c => c.Producto)
                .OrderBy(p => p.Id).ToListAsync(ct);
            return Results.Ok(lista.Select(p => Mapear(p, hoy)));
        })
        .RequireRoles(Roles.Administrador);

        app.MapPost("/api/promociones", async (PromocionRequest s, AppDbContext db, CancellationToken ct) =>
        {
            var promocion = new Promocion();
            var error = await AplicarAsync(promocion, s, db, ct);
            if (error is not null) return error;
            db.Promociones.Add(promocion);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { return Util.Error(409, "Ya existe una promoción con ese nombre."); }
            return Results.Created($"/api/promociones/{promocion.Id}", await CargarAsync(promocion.Id, db, ct));
        })
        .RequireRoles(Roles.Administrador);

        app.MapPut("/api/promociones/{id:int}", async (int id, PromocionRequest s, AppDbContext db, CancellationToken ct) =>
        {
            var promocion = await db.Promociones.Include(p => p.Componentes).FirstOrDefaultAsync(p => p.Id == id, ct);
            if (promocion is null) return Util.Error(404, "La promoción no existe.");
            var error = await AplicarAsync(promocion, s, db, ct);
            if (error is not null) return error;
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { return Util.Error(409, "Ya existe una promoción con ese nombre."); }
            return Results.Ok(await CargarAsync(id, db, ct));
        })
        .RequireRoles(Roles.Administrador);

        app.MapPatch("/api/promociones/{id:int}/estado", async (int id, EstadoActivoRequest s, AppDbContext db, CancellationToken ct) =>
        {
            var promocion = await db.Promociones.FirstOrDefaultAsync(p => p.Id == id, ct);
            if (promocion is null) return Util.Error(404, "La promoción no existe.");
            promocion.Activa = s.Activa;
            await db.SaveChangesAsync(ct);
            return Results.Ok(await CargarAsync(id, db, ct));
        })
        .RequireRoles(Roles.Administrador);

        app.MapDelete("/api/promociones/{id:int}", async (int id, AppDbContext db, CancellationToken ct) =>
        {
            var promocion = await db.Promociones.FirstOrDefaultAsync(p => p.Id == id, ct);
            if (promocion is null) return Util.Error(404, "La promoción no existe.");
            if (await db.DetallesPedido.AnyAsync(d => d.PromocionId == id, ct))
            {
                promocion.Activa = false;
                await db.SaveChangesAsync(ct);
                return Results.Ok(new { desactivado = true, mensaje = "La promoción ya se vendió en pedidos; se desactivó para conservar el historial." });
            }
            db.Promociones.Remove(promocion);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { desactivado = false, mensaje = "Promoción eliminada." });
        })
        .RequireRoles(Roles.Administrador);

        return app;
    }

    private static async Task<PromocionDto?> CargarAsync(int id, AppDbContext db, CancellationToken ct)
    {
        var promocion = await db.Promociones.AsNoTracking()
            .Include(p => p.Componentes).ThenInclude(c => c.Producto)
            .FirstOrDefaultAsync(p => p.Id == id, ct);
        return promocion is null ? null : Mapear(promocion, TiempoColombia.Hoy());
    }

    private static PromocionDto Mapear(Promocion p, DateOnly hoy)
    {
        var calculo = PromocionCalculadora.Calcular(p);
        return new PromocionDto(p.Id, p.Nombre, p.Descripcion, p.Emoji, p.Publico, p.TipoDescuento, p.ValorDescuento,
            p.FechaInicio, p.FechaFin, p.Activa, PromocionCalculadora.Vigente(p, hoy),
            p.Componentes.OrderBy(c => c.Id)
                .Select(c => new PromocionComponenteDto(c.ProductoId, c.Producto?.Nombre ?? "", c.Tamano, c.Cantidad)).ToList(),
            calculo?.Normal, calculo?.Descuento, calculo?.Final, p.Imagen);
    }

    private static async Task<IResult?> AplicarAsync(Promocion promocion, PromocionRequest s, AppDbContext db, CancellationToken ct)
    {
        var nombre = Util.Limpiar(s.Nombre, 80);
        var descripcion = Util.Limpiar(s.Descripcion, 180);
        var publico = Publicos.FirstOrDefault(x => x == s.Publico?.Trim().ToLowerInvariant());
        var tipo = Tipos.FirstOrDefault(x => x == s.TipoDescuento?.Trim().ToLowerInvariant());
        if (nombre.Length < 2) return Util.Error(400, "El nombre de la promoción es obligatorio.");
        if (descripcion.Length == 0) return Util.Error(400, "La descripción es obligatoria.");
        if (publico is null) return Util.Error(400, "El público debe ser «general» o «clientes».");
        if (tipo is null) return Util.Error(400, "El tipo de descuento debe ser «precio», «fijo» o «porcentaje».");
        if (s.ValorDescuento < 0) return Util.Error(400, "El valor del descuento no puede ser negativo.");
        if (tipo == "porcentaje" && s.ValorDescuento > 100) return Util.Error(400, "El porcentaje no puede superar 100.");
        if (s.FechaInicio is { } inicio && s.FechaFin is { } fin && inicio > fin)
            return Util.Error(400, "La fecha de inicio no puede ser posterior a la de fin.");
        if (s.Componentes is null || s.Componentes.Count == 0)
            return Util.Error(400, "Agrega al menos un producto a la promoción.");
        if (await db.Promociones.AnyAsync(p => p.Id != promocion.Id && p.Nombre.ToLower() == nombre.ToLower(), ct))
            return Util.Error(409, "Ya existe una promoción con ese nombre.");

        var ids = s.Componentes.Select(c => c.ProductoId).Distinct().ToList();
        var productos = await db.Productos.AsNoTracking().Where(p => ids.Contains(p.Id)).ToDictionaryAsync(p => p.Id, ct);
        var componentes = new List<PromocionComponente>();
        foreach (var c in s.Componentes)
        {
            if (!productos.TryGetValue(c.ProductoId, out var producto))
                return Util.Error(400, "La promoción incluye un producto que no existe.");
            if (c.Cantidad is < 1 or > 20)
                return Util.Error(400, "La cantidad de cada producto debe estar entre 1 y 20.");
            string tamano;
            if (producto.EsPizza)
            {
                var normalizado = Tamanos.Normalizar(c.Tamano);
                if (normalizado is null || producto.PrecioPara(normalizado) is null)
                    return Util.Error(400, $"Selecciona un tamaño válido para {producto.Nombre}.");
                tamano = normalizado;
            }
            else
            {
                tamano = string.Empty;
            }
            componentes.Add(new PromocionComponente { ProductoId = producto.Id, Tamano = tamano, Cantidad = c.Cantidad });
        }

        var precioNormal = componentes.Sum(c => productos[c.ProductoId].PrecioPara(c.Tamano)!.Value * c.Cantidad);
        if (tipo == "precio" && s.ValorDescuento > precioNormal)
            return Util.Error(400, "El precio especial no puede superar el precio normal del combo.");

        promocion.Nombre = nombre;
        promocion.Descripcion = descripcion;
        promocion.Emoji = Util.Limpiar(s.Emoji, 12) is { Length: > 0 } emoji ? emoji : "🎁";
        if (s.Imagen is not null) promocion.Imagen = Util.Limpiar(s.Imagen, 500);
        promocion.Publico = publico;
        promocion.TipoDescuento = tipo;
        promocion.ValorDescuento = decimal.Round(s.ValorDescuento, 2);
        promocion.FechaInicio = s.FechaInicio;
        promocion.FechaFin = s.FechaFin;
        promocion.Activa = s.Activa ?? true;

        db.PromocionComponentes.RemoveRange(promocion.Componentes.ToList());
        promocion.Componentes.Clear();
        foreach (var componente in componentes) promocion.Componentes.Add(componente);
        return null;
    }
}
