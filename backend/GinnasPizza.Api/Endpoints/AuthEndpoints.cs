using GinnasPizza.Api.Contracts;
using GinnasPizza.Api.Data;
using GinnasPizza.Api.Models;
using GinnasPizza.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Endpoints;

public static class AuthEndpoints
{
    public static WebApplication MapAuth(this WebApplication app)
    {
        // ── Personal interno ──
        app.MapPost("/api/auth/login", async (LoginRequest solicitud, AppDbContext db, TokenService tokens, HttpContext http, CancellationToken ct) =>
        {
            var correo = Util.NormalizarCorreo(solicitud.Correo);
            // Se acepta también el usuario corto (admin, cajero, mesera): equivale a usuario@ginnaspizza.com.
            if (correo.Length > 0 && !correo.Contains('@')) correo += "@" + DatabaseSeeder.DominioPersonal;
            var password = solicitud.Password ?? string.Empty;
            if (correo.Length == 0 || password.Length == 0)
                return Util.Error(400, "Ingresa tu correo o usuario y contraseña.");

            var clave = $"staff|{Util.Ip(http)}|{correo}";
            if (LimitadorLogin.Bloqueado(clave))
                return Util.Error(429, "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo.");

            var usuario = await db.Usuarios.AsNoTracking().FirstOrDefaultAsync(u => u.Correo == correo, ct);
            if (usuario is null)
            {
                PasswordHasher.VerificacionFalsa(password);
            }
            else if (PasswordHasher.Verificar(password, usuario.PasswordHash))
            {
                if (!usuario.Activo)
                    return Util.Error(403, "Esta cuenta está inactiva. Contacta a un administrador.");
                if (!Roles.EsInterno(usuario.Rol))
                    return Util.Error(403, "Esta cuenta no tiene un rol válido asignado.");
                LimitadorLogin.Limpiar(clave);
                return Results.Ok(new
                {
                    token = tokens.Emitir(usuario.Id, usuario.Rol, usuario.Nombre, usuario.Correo),
                    usuario = new { id = usuario.Id, nombre = usuario.Nombre, correo = usuario.Correo, rol = usuario.Rol }
                });
            }

            LimitadorLogin.RegistrarFallo(clave);
            return Util.Error(401, "Credenciales incorrectas o cuenta inactiva.");
        })
        .WithName("Login")
        .WithSummary("Inicio de sesión del personal (Administrador, Cajero, Mesera)");

        app.MapGet("/api/auth/me", (HttpContext http) =>
        {
            var sesion = http.Sesion();
            return Results.Ok(new { id = sesion.Id, nombre = sesion.Nombre, correo = sesion.Correo, rol = sesion.Rol });
        })
        .RequireRoles(Roles.Internos)
        .WithName("SesionActual");

        // ── Clientes de la tienda ──
        app.MapPost("/api/clientes/registro", async (RegistroClienteRequest solicitud, AppDbContext db, CancellationToken ct) =>
        {
            var nombre = Util.Limpiar(solicitud.Nombre, 120);
            var correo = Util.NormalizarCorreo(solicitud.Correo);
            var password = solicitud.Password ?? string.Empty;
            var telefono = Util.Limpiar(solicitud.Telefono, 25);

            if (nombre.Length < 2) return Util.Error(400, "Ingresa tu nombre.");
            if (!Util.CorreoValido(correo)) return Util.Error(400, "Ingresa un correo electrónico válido.");
            if (password.Length < 8 || password.Length > 100) return Util.Error(400, "La contraseña debe tener entre 8 y 100 caracteres.");
            if (telefono.Length > 0 && !Util.TelefonoValido(telefono)) return Util.Error(400, "El teléfono debe tener entre 7 y 15 dígitos.");

            var existente = await db.Clientes.FirstOrDefaultAsync(c => c.Correo == correo, ct);
            if (existente is not null)
            {
                // Un cliente creado en mostrador (sin contraseña) puede activar su cuenta web con el mismo correo.
                if (existente.PasswordHash.Length > 0)
                    return Util.Error(409, "Ya existe una cuenta con ese correo.");
                existente.PasswordHash = PasswordHasher.Hash(password);
                existente.Nombre = nombre;
                if (telefono.Length > 0) existente.Telefono = telefono;
                existente.Activo = true;
                await db.SaveChangesAsync(ct);
                return Results.Created($"/api/clientes/{existente.Id}", new { id = existente.Id, nombre = existente.Nombre, correo = existente.Correo });
            }

            var cliente = new Cliente { Nombre = nombre, Correo = correo, Telefono = telefono, PasswordHash = PasswordHasher.Hash(password) };
            db.Clientes.Add(cliente);
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException)
            {
                return Util.Error(409, "Ya existe una cuenta con ese correo.");
            }
            return Results.Created($"/api/clientes/{cliente.Id}", new { id = cliente.Id, nombre = cliente.Nombre, correo = cliente.Correo });
        })
        .WithName("RegistroCliente");

        app.MapPost("/api/clientes/login", async (LoginRequest solicitud, AppDbContext db, TokenService tokens, HttpContext http, CancellationToken ct) =>
        {
            var correo = Util.NormalizarCorreo(solicitud.Correo);
            var password = solicitud.Password ?? string.Empty;
            if (correo.Length == 0 || password.Length == 0)
                return Util.Error(400, "Ingresa tu correo y contraseña.");

            var clave = $"cliente|{Util.Ip(http)}|{correo}";
            if (LimitadorLogin.Bloqueado(clave))
                return Util.Error(429, "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo.");

            var cliente = await db.Clientes.AsNoTracking().FirstOrDefaultAsync(c => c.Correo == correo, ct);
            if (cliente is null || cliente.PasswordHash.Length == 0)
            {
                PasswordHasher.VerificacionFalsa(password);
            }
            else if (PasswordHasher.Verificar(password, cliente.PasswordHash) && cliente.Activo)
            {
                LimitadorLogin.Limpiar(clave);
                return Results.Ok(new
                {
                    token = tokens.Emitir(cliente.Id, Roles.Cliente, cliente.Nombre, cliente.Correo),
                    cliente = new { id = cliente.Id, nombre = cliente.Nombre, email = cliente.Correo, correo = cliente.Correo, rol = Roles.Cliente }
                });
            }

            LimitadorLogin.RegistrarFallo(clave);
            return Util.Error(401, "Correo o contraseña incorrectos.");
        })
        .WithName("LoginCliente");

        app.MapGet("/api/clientes/me", (HttpContext http) =>
        {
            var sesion = http.Sesion();
            return Results.Ok(new { id = sesion.Id, nombre = sesion.Nombre, email = sesion.Correo, correo = sesion.Correo, rol = Roles.Cliente });
        })
        .RequireRoles(Roles.Cliente)
        .WithName("SesionCliente");

        return app;
    }
}
