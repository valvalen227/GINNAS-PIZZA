using GinnasPizza.Api.Contracts;
using GinnasPizza.Api.Data;
using GinnasPizza.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Endpoints;

public static class ProveedoresEndpoints
{
    public static WebApplication MapProveedores(this WebApplication app)
    {
        app.MapGet("/api/proveedores", async (AppDbContext db, CancellationToken ct) =>
            Results.Ok((await db.Proveedores.AsNoTracking().OrderBy(p => p.Nombre).ToListAsync(ct)).Select(ProveedorDto.De)))
            .RequireRoles(Roles.Administrador);

        app.MapPost("/api/proveedores", async (ProveedorRequest s, AppDbContext db, CancellationToken ct) =>
        {
            var proveedor = new Proveedor();
            var error = await AplicarAsync(proveedor, s, db, ct);
            if (error is not null) return error;
            db.Proveedores.Add(proveedor);
            await db.SaveChangesAsync(ct);
            return Results.Created($"/api/proveedores/{proveedor.Id}", ProveedorDto.De(proveedor));
        })
        .RequireRoles(Roles.Administrador);

        app.MapPut("/api/proveedores/{id:int}", async (int id, ProveedorRequest s, AppDbContext db, CancellationToken ct) =>
        {
            var proveedor = await db.Proveedores.FirstOrDefaultAsync(p => p.Id == id, ct);
            if (proveedor is null) return Util.Error(404, "El proveedor no existe.");
            var error = await AplicarAsync(proveedor, s, db, ct);
            if (error is not null) return error;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ProveedorDto.De(proveedor));
        })
        .RequireRoles(Roles.Administrador);

        app.MapPatch("/api/proveedores/{id:int}/estado", async (int id, EstadoActivoRequest s, AppDbContext db, CancellationToken ct) =>
        {
            var proveedor = await db.Proveedores.FirstOrDefaultAsync(p => p.Id == id, ct);
            if (proveedor is null) return Util.Error(404, "El proveedor no existe.");
            proveedor.Activo = s.Activa;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ProveedorDto.De(proveedor));
        })
        .RequireRoles(Roles.Administrador);

        app.MapDelete("/api/proveedores/{id:int}", async (int id, AppDbContext db, CancellationToken ct) =>
        {
            var proveedor = await db.Proveedores.FirstOrDefaultAsync(p => p.Id == id, ct);
            if (proveedor is null) return Util.Error(404, "El proveedor no existe.");
            if (await db.Ingredientes.AnyAsync(i => i.ProveedorId == id, ct))
            {
                proveedor.Activo = false;
                await db.SaveChangesAsync(ct);
                return Results.Ok(new { desactivado = true, mensaje = "El proveedor está relacionado con ingredientes; se desactivó para conservar esas referencias." });
            }
            db.Proveedores.Remove(proveedor);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { desactivado = false, mensaje = "Proveedor eliminado." });
        })
        .RequireRoles(Roles.Administrador);

        return app;
    }

    private static async Task<IResult?> AplicarAsync(Proveedor proveedor, ProveedorRequest s, AppDbContext db, CancellationToken ct)
    {
        var nombre = Util.Limpiar(s.Nombre, 120);
        var telefono = Util.Limpiar(s.Telefono, 30);
        var correo = Util.NormalizarCorreo(s.Correo);
        if (nombre.Length < 2) return Util.Error(400, "El nombre del proveedor es obligatorio.");
        if (telefono.Length > 0 && !Util.TelefonoValido(telefono)) return Util.Error(400, "El teléfono debe tener entre 7 y 15 dígitos.");
        if (correo.Length > 0 && !Util.CorreoValido(correo)) return Util.Error(400, "El correo no es válido.");

        var telefonoNormalizado = new string(telefono.Where(c => char.IsDigit(c) || c == '+').ToArray());
        var otros = await db.Proveedores.AsNoTracking().Where(p => p.Id != proveedor.Id).ToListAsync(ct);
        var duplicado = otros.Any(p =>
            string.Equals(p.Nombre, nombre, StringComparison.OrdinalIgnoreCase)
            || (correo.Length > 0 && string.Equals(p.Correo, correo, StringComparison.OrdinalIgnoreCase))
            || (telefonoNormalizado.Length > 0 && new string(p.Telefono.Where(c => char.IsDigit(c) || c == '+').ToArray()) == telefonoNormalizado));
        if (duplicado) return Util.Error(409, "Ya existe un proveedor con el mismo nombre, correo o teléfono.");

        proveedor.Nombre = nombre;
        proveedor.Empresa = Util.Limpiar(s.Empresa, 120);
        proveedor.Identificacion = Util.Limpiar(s.Identificacion, 40);
        proveedor.Telefono = telefono;
        proveedor.Correo = correo;
        proveedor.Direccion = Util.Limpiar(s.Direccion, 180);
        proveedor.Productos = Util.Limpiar(s.Productos, 180);
        proveedor.Observaciones = Util.Limpiar(s.Observaciones, 300);
        if (s.Activo.HasValue) proveedor.Activo = s.Activo.Value;
        return null;
    }
}
