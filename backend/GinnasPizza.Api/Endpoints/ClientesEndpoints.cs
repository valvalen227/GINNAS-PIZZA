using GinnasPizza.Api.Contracts;
using GinnasPizza.Api.Data;
using GinnasPizza.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Endpoints;

public static class ClientesEndpoints
{
    public static WebApplication MapClientes(this WebApplication app)
    {
        app.MapGet("/api/clientes", async (AppDbContext db, CancellationToken ct) =>
            Results.Ok((await db.Clientes.AsNoTracking().OrderBy(c => c.Nombre).ToListAsync(ct)).Select(ClienteDto.De)))
            .RequireRoles(Roles.Administrador, Roles.Cajero, Roles.Mesera);

        app.MapPost("/api/clientes", async (ClienteRequest solicitud, AppDbContext db, CancellationToken ct) =>
        {
            var cliente = new Cliente();
            var error = await AplicarAsync(cliente, solicitud, db, ct);
            if (error is not null) return error;
            db.Clientes.Add(cliente);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { return Util.Error(409, "Ya existe un cliente con ese correo."); }
            return Results.Created($"/api/clientes/{cliente.Id}", ClienteDto.De(cliente));
        })
        .RequireRoles(Roles.Administrador);

        app.MapPut("/api/clientes/{id:int}", async (int id, ClienteRequest solicitud, AppDbContext db, CancellationToken ct) =>
        {
            var cliente = await db.Clientes.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (cliente is null) return Util.Error(404, "El cliente no existe.");
            var error = await AplicarAsync(cliente, solicitud, db, ct);
            if (error is not null) return error;
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { return Util.Error(409, "Ya existe un cliente con ese correo."); }
            return Results.Ok(ClienteDto.De(cliente));
        })
        .RequireRoles(Roles.Administrador);

        app.MapDelete("/api/clientes/{id:int}", async (int id, AppDbContext db, CancellationToken ct) =>
        {
            var cliente = await db.Clientes.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (cliente is null) return Util.Error(404, "El cliente no existe.");

            if (await db.Pedidos.AnyAsync(p => p.ClienteId == id, ct))
            {
                // Conserva el historial de pedidos y ventas: solo se desactiva.
                cliente.Activo = false;
                await db.SaveChangesAsync(ct);
                return Results.Ok(new { desactivado = true, mensaje = "El cliente tiene pedidos asociados; se desactivó y se conservó su historial." });
            }
            db.Clientes.Remove(cliente);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { desactivado = false, mensaje = "Cliente eliminado." });
        })
        .RequireRoles(Roles.Administrador);

        return app;
    }

    private static async Task<IResult?> AplicarAsync(Cliente cliente, ClienteRequest s, AppDbContext db, CancellationToken ct)
    {
        var nombre = Util.Limpiar(s.Nombre, 120);
        var correo = Util.NormalizarCorreo(s.Correo);
        var telefono = Util.Limpiar(s.Telefono, 25);
        if (nombre.Length < 2) return Util.Error(400, "El nombre es obligatorio.");
        if (correo.Length > 0 && !Util.CorreoValido(correo)) return Util.Error(400, "El correo no es válido.");
        if (telefono.Length > 0 && !Util.TelefonoValido(telefono)) return Util.Error(400, "El teléfono debe tener entre 7 y 15 dígitos.");
        if (correo.Length > 0 && await db.Clientes.AnyAsync(c => c.Correo == correo && c.Id != cliente.Id, ct))
            return Util.Error(409, "Ya existe un cliente con ese correo.");

        cliente.Nombre = nombre;
        cliente.Correo = correo;
        cliente.Telefono = telefono;
        cliente.Identificacion = Util.Limpiar(s.Identificacion, 40);
        cliente.Direccion = Util.Limpiar(s.Direccion, 180);
        if (s.Activo.HasValue) cliente.Activo = s.Activo.Value;
        return null;
    }
}
