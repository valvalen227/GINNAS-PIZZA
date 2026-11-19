namespace GinnasPizza.Api.Services;

/// <summary>
/// Utilidades de zona horaria de Colombia (UTC-5, sin horario de verano).
/// Todo se guarda en UTC; solo se convierte al agrupar o filtrar por día calendario.
/// </summary>
public static class TiempoColombia
{
    public static readonly TimeSpan Offset = TimeSpan.FromHours(-5);

    /// <summary>Convierte un instante UTC a la hora local de Colombia (Kind = Unspecified).</summary>
    public static DateTime ALocal(DateTime utc) =>
        DateTime.SpecifyKind(utc.Add(Offset), DateTimeKind.Unspecified);

    public static DateOnly Hoy() => DateOnly.FromDateTime(ALocal(DateTime.UtcNow));

    public static DateOnly DiaDe(DateTime utc) => DateOnly.FromDateTime(ALocal(utc));

    /// <summary>Instante UTC en que empieza el día calendario colombiano indicado (00:00 COT = 05:00 UTC).</summary>
    public static DateTime InicioDiaUtc(DateOnly dia) =>
        DateTime.SpecifyKind(dia.ToDateTime(TimeOnly.MinValue) - Offset, DateTimeKind.Utc);

    /// <summary>Último instante UTC del día calendario colombiano indicado.</summary>
    public static DateTime FinDiaUtc(DateOnly dia) => InicioDiaUtc(dia.AddDays(1)).AddTicks(-1);

    public static bool TryParseDia(string? texto, out DateOnly dia) =>
        DateOnly.TryParseExact(texto, "yyyy-MM-dd", out dia);
}
