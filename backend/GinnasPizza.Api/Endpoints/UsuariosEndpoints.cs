using GinnasPizza.Api.Contracts;
using GinnasPizza.Api.Data;
using GinnasPizza.Api.Models;
using GinnasPizza.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Endpoints;

public static class UsuariosEndpoints
{
    public static WebApplication MapUsuarios(this WebApplication app)
    {
        app.MapGet("/api/usuarios", async (AppDbContext db, CancellationToken ct) =>
            Results.Ok((await db.Usuarios.AsNoTracking().OrderBy(u => u.Id).ToListAsync(ct)).Select(UsuarioDto.De)))
            .RequireRoles(Roles.Administrador);

        app.MapPost("/api/usuarios", async (UsuarioRequest s, AppDbContext db, CancellationToken ct) =>
        {
            var nombre = Util.Limpiar(s.Nombre, 120);
            var correo = Util.NormalizarCorreo(s.Correo);
            var rol = Roles.Internos.FirstOrDefault(r => string.Equals(r, s.Rol?.Trim(), StringComparison.OrdinalIgnoreCase));
            var password = s.Password ?? string.Empty;
            if (nombre.Length < 2) return Util.Error(400, "El nombre es obligatorio.");
            if (!Util.CorreoValido(correo)) return Util.Error(400, "Ingresa un correo electrónico válido.");
            if (rol is null) return Util.Error(400, "Selecciona un rol válido (Administrador, Cajero o Mesera).");
            if (password.Length < 8 || password.Length > 100) return Util.Error(400, "La contraseña debe tener entre 8 y 100 caracteres.");
            if (await db.Usuarios.AnyAsync(u => u.Correo == correo, ct)) return Util.Error(409, "Ya existe una cuenta con ese correo.");

            var usuario = new Usuario
            {
                Nombre = nombre, Correo = correo, Rol = rol, Activo = s.Activo ?? true,
                PasswordHash = PasswordHasher.Hash(password), FechaCreacion = DateTime.UtcNow
            };
            db.Usuarios.Add(usuario);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { return Util.Error(409, "Ya existe una cuenta con ese correo."); }
            return Results.Created($"/api/usuarios/{usuario.Id}", UsuarioDto.De(usuario));
        })
        .RequireRoles(Roles.Administrador);

        app.MapPut("/api/usuarios/{id:int}", async (int id, UsuarioRequest s, AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            var usuario = await db.Usuarios.FirstOrDefaultAsync(u => u.Id == id, ct);
            if (usuario is null) return Util.Error(404, "El usuario no existe.");

            var rol = s.Rol is null ? usuario.Rol : Roles.Internos.FirstOrDefault(r => string.Equals(r, s.Rol.Trim(), StringComparison.OrdinalIgnoreCase));
            if (rol is null) return Util.Error(400, "Selecciona un rol válido (Administrador, Cajero o Mesera).");
            var activo = s.Activo ?? usuario.Activo;
            var esMismo = http.Sesion().Id == id;
            if (esMismo && (rol != usuario.Rol || !activo))
                return Util.Error(409, "No puedes cambiar tu propio rol ni desactivar tu propia cuenta.");

            if (s.Nombre is not null)
            {
                var nombre = Util.Limpiar(s.Nombre, 120);
                if (nombre.Length < 2) return Util.Error(400, "El nombre es obligatorio.");
                usuario.Nombre = nombre;
            }
            usuario.Rol = rol;
            usuario.Activo = activo;
            await db.SaveChangesAsync(ct);
            return Results.Ok(UsuarioDto.De(usuario));
        })
        .RequireRoles(Roles.Administrador);

        // El administrador define una contraseña nueva; nunca se puede consultar la actual.
        app.MapPost("/api/usuarios/{id:int}/password", async (int id, PasswordRequest s, AppDbContext db, CancellationToken ct) =>
        {
            var password = s.Password ?? string.Empty;
            if (password.Length < 8 || password.Length > 100) return Util.Error(400, "La contraseña debe tener entre 8 y 100 caracteres.");
            var usuario = await db.Usuarios.FirstOrDefaultAsync(u => u.Id == id, ct);
            if (usuario is null) return Util.Error(404, "El usuario no existe.");
            usuario.PasswordHash = PasswordHasher.Hash(password);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { mensaje = "Contraseña actualizada." });
        })
        .RequireRoles(Roles.Administrador);

        app.MapDelete("/api/usuarios/{id:int}", async (int id, AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            if (http.Sesion().Id == id) return Util.Error(409, "No puedes eliminar tu propia cuenta.");
            var usuario = await db.Usuarios.FirstOrDefaultAsync(u => u.Id == id, ct);
            if (usuario is null) return Util.Error(404, "El usuario no existe.");
            db.Usuarios.Remove(usuario);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { mensaje = "Usuario eliminado." });
        })
        .RequireRoles(Roles.Administrador);

        return app;
    }
}
