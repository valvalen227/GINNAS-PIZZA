using System.Security.Cryptography;

namespace GinnasPizza.Api.Services;

/// <summary>Hash de contraseñas con PBKDF2-SHA256 (formato: PBKDF2$iteraciones$sal$hash).</summary>
public static class PasswordHasher
{
    private const int Iteraciones = 210_000;
    private const int TamanoSal = 16;
    private const int TamanoHash = 32;

    public static string Hash(string password)
    {
        var sal = RandomNumberGenerator.GetBytes(TamanoSal);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, sal, Iteraciones, HashAlgorithmName.SHA256, TamanoHash);
        return $"PBKDF2${Iteraciones}${Convert.ToBase64String(sal)}${Convert.ToBase64String(hash)}";
    }

    public static bool Verificar(string password, string? almacenado)
    {
        if (string.IsNullOrEmpty(almacenado)) return false;
        var partes = almacenado.Split('$');
        if (partes.Length != 4 || partes[0] != "PBKDF2" || !int.TryParse(partes[1], out var iteraciones)) return false;
        try
        {
            var sal = Convert.FromBase64String(partes[2]);
            var esperado = Convert.FromBase64String(partes[3]);
            var calculado = Rfc2898DeriveBytes.Pbkdf2(password, sal, iteraciones, HashAlgorithmName.SHA256, esperado.Length);
            return CryptographicOperations.FixedTimeEquals(calculado, esperado);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    /// <summary>Consume el mismo tiempo que una verificación real (evita revelar si el correo existe).</summary>
    public static void VerificacionFalsa(string password) =>
        _ = Verificar(password, DummyHash.Value);

    private static class DummyHash
    {
        public static readonly string Value = Hash("contraseña-inexistente");
    }
}
