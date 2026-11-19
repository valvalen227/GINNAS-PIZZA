using GinnasPizza.Api.Data;
using GinnasPizza.Api.Models;
using GinnasPizza.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Endpoints;

/// <summary>Sesión ya validada contra la base de datos (rol y estado actuales, no los del token).</summary>
public sealed record SesionActual(int Id, string Rol, string Nombre, string Correo);

public static class Autorizacion
{
    private const string Clave = "ginnas.sesion";

    /// <summary>
    /// Exige un token válido cuyo usuario siga activo en la base de datos y tenga alguno de los roles indicados.
    /// El rol se lee de la base de datos, de modo que un cambio de rol o una desactivación aplican de inmediato.
    /// </summary>
    public static RouteHandlerBuilder RequireRoles(this RouteHandlerBuilder builder, params string[] roles) =>
        builder.AddEndpointFilter(async (contexto, siguiente) =>
        {
            var http = contexto.HttpContext;
            var sesion = await ResolverSesionAsync(http);
            if (sesion is null)
                return Results.Json(new { error = "Sesión no válida o expirada. Inicia sesión nuevamente." }, statusCode: StatusCodes.Status401Unauthorized);
            if (!roles.Contains(sesion.Rol))
                return Results.Json(new { error = "Tu rol no tiene permiso para esta acción." }, statusCode: StatusCodes.Status403Forbidden);
            http.Items[Clave] = sesion;
            return await siguiente(contexto);
        });

    public static SesionActual Sesion(this HttpContext http) =>
        (SesionActual)http.Items[Clave]!;

    /// <summary>Sesión opcional (para endpoints públicos que ofrecen más contenido a clientes autenticados).</summary>
    public static Task<SesionActual?> SesionOpcionalAsync(this HttpContext http) => ResolverSesionAsync(http);

    private static async Task<SesionActual?> ResolverSesionAsync(HttpContext http)
    {
        var tokens = http.RequestServices.GetRequiredService<TokenService>();
        var token = tokens.Leer(http.Request);
        if (token is null) return null;
        var db = http.RequestServices.GetRequiredService<AppDbContext>();
        var cancelacion = http.RequestAborted;

        if (token.Rol == Roles.Cliente)
        {
            var cliente = await db.Clientes.AsNoTracking()
                .Where(c => c.Id == token.Id && c.Activo)
                .Select(c => new { c.Id, c.Nombre, c.Correo })
                .FirstOrDefaultAsync(cancelacion);
            return cliente is null ? null : new SesionActual(cliente.Id, Roles.Cliente, cliente.Nombre, cliente.Correo);
        }

        if (!Roles.EsInterno(token.Rol)) return null;
        var usuario = await db.Usuarios.AsNoTracking()
            .Where(u => u.Id == token.Id && u.Activo)
            .Select(u => new { u.Id, u.Nombre, u.Correo, u.Rol })
            .FirstOrDefaultAsync(cancelacion);
        return usuario is null || !Roles.EsInterno(usuario.Rol)
            ? null
            : new SesionActual(usuario.Id, usuario.Rol, usuario.Nombre, usuario.Correo);
    }
}
