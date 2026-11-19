using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;

namespace GinnasPizza.Api.Services;

/// <summary>Datos de la sesión contenidos en un token válido.</summary>
public sealed record SesionToken(int Id, string Rol, string Nombre, string Correo, DateTimeOffset Expira);

/// <summary>
/// Tokens firmados con HMAC-SHA256 (payload JSON en Base64Url + "." + firma).
/// Sin dependencias externas; el servidor valida firma y expiración en cada petición.
/// </summary>
public sealed class TokenService
{
    private readonly byte[] _clave;
    private readonly TimeSpan _vida;

    private sealed record Payload(int Id, string Rol, string Nombre, string Correo, long Exp);

    public TokenService(IConfiguration configuracion)
    {
        var texto = configuracion["Auth:SigningKey"];
        if (string.IsNullOrWhiteSpace(texto) || texto.Length < 32)
            throw new InvalidOperationException("Auth:SigningKey debe tener al menos 32 caracteres.");
        _clave = Encoding.UTF8.GetBytes(texto);
        _vida = TimeSpan.FromHours(double.TryParse(configuracion["Auth:TokenHoras"], out var horas) && horas > 0 ? horas : 12);
    }

    public string Emitir(int id, string rol, string nombre, string correo)
    {
        var expira = DateTimeOffset.UtcNow.Add(_vida).ToUnixTimeSeconds();
        var json = JsonSerializer.SerializeToUtf8Bytes(new Payload(id, rol, nombre, correo, expira));
        var cuerpo = WebEncoders.Base64UrlEncode(json);
        return $"{cuerpo}.{WebEncoders.Base64UrlEncode(Firmar(cuerpo))}";
    }

    public SesionToken? Validar(string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        var partes = token.Split('.');
        if (partes.Length != 2) return null;
        try
        {
            var firmaRecibida = WebEncoders.Base64UrlDecode(partes[1]);
            if (!CryptographicOperations.FixedTimeEquals(firmaRecibida, Firmar(partes[0]))) return null;
            var payload = JsonSerializer.Deserialize<Payload>(WebEncoders.Base64UrlDecode(partes[0]));
            if (payload is null) return null;
            var expira = DateTimeOffset.FromUnixTimeSeconds(payload.Exp);
            if (expira <= DateTimeOffset.UtcNow) return null;
            return new SesionToken(payload.Id, payload.Rol, payload.Nombre, payload.Correo, expira);
        }
        catch (Exception ex) when (ex is FormatException or JsonException or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>Lee el token del encabezado Authorization: Bearer.</summary>
    public SesionToken? Leer(HttpRequest peticion)
    {
        var encabezado = peticion.Headers.Authorization.ToString();
        const string prefijo = "Bearer ";
        return encabezado.StartsWith(prefijo, StringComparison.OrdinalIgnoreCase)
            ? Validar(encabezado[prefijo.Length..].Trim())
            : null;
    }

    private byte[] Firmar(string cuerpo) => HMACSHA256.HashData(_clave, Encoding.UTF8.GetBytes(cuerpo));
}
