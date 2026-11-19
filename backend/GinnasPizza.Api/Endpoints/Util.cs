using System.Collections.Concurrent;
using System.Net.Mail;

namespace GinnasPizza.Api.Endpoints;

internal static class Util
{
    /// <summary>Recorta espacios y limita la longitud (nunca devuelve null).</summary>
    public static string Limpiar(string? valor, int max = 200)
    {
        var texto = (valor ?? string.Empty).Trim();
        return texto.Length > max ? texto[..max] : texto;
    }

    public static IResult Error(int estado, string mensaje) => Results.Json(new { error = mensaje }, statusCode: estado);

    public static bool CorreoValido(string correo) =>
        correo.Length is > 3 and <= 160
        && MailAddress.TryCreate(correo, out var direccion)
        && direccion.Address == correo
        && correo.Contains('.', StringComparison.Ordinal);

    public static string NormalizarCorreo(string? correo) => (correo ?? string.Empty).Trim().ToLowerInvariant();

    public static bool TelefonoValido(string telefono)
    {
        var digitos = telefono.Count(char.IsDigit);
        return digitos is >= 7 and <= 15;
    }

    public static string Ip(HttpContext http) => http.Connection.RemoteIpAddress?.ToString() ?? "desconocida";
}

/// <summary>Limitador sencillo de intentos fallidos de inicio de sesión (por correo + IP).</summary>
internal static class LimitadorLogin
{
    private const int MaxFallos = 8;
    private static readonly TimeSpan Ventana = TimeSpan.FromMinutes(10);
    private static readonly ConcurrentDictionary<string, (int Fallos, DateTime Inicio)> Intentos = new();

    public static bool Bloqueado(string clave)
    {
        if (!Intentos.TryGetValue(clave, out var estado)) return false;
        if (DateTime.UtcNow - estado.Inicio > Ventana)
        {
            Intentos.TryRemove(clave, out _);
            return false;
        }
        return estado.Fallos >= MaxFallos;
    }

    public static void RegistrarFallo(string clave) =>
        Intentos.AddOrUpdate(clave,
            _ => (1, DateTime.UtcNow),
            (_, actual) => DateTime.UtcNow - actual.Inicio > Ventana ? (1, DateTime.UtcNow) : (actual.Fallos + 1, actual.Inicio));

    public static void Limpiar(string clave) => Intentos.TryRemove(clave, out _);
}
