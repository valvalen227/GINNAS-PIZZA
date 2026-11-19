namespace GinnasPizza.Api.Models;

/// <summary>Roles válidos del sistema.</summary>
public static class Roles
{
    public const string Administrador = "Administrador";
    public const string Cajero = "Cajero";
    public const string Mesera = "Mesera";
    public const string Cliente = "Cliente";

    public static readonly string[] Internos = [Administrador, Cajero, Mesera];

    public static bool EsInterno(string? rol) => rol is Administrador or Cajero or Mesera;
}

/// <summary>Tamaños de pizza soportados y utilidades de normalización.</summary>
public static class Tamanos
{
    public const string Personal = "Personal";
    public const string Mediana = "Mediana";
    public const string Familiar = "Familiar";

    public static readonly string[] Pizza = [Personal, Mediana, Familiar];

    /// <summary>Devuelve el tamaño con su capitalización canónica o null si no es válido.</summary>
    public static string? Normalizar(string? valor)
    {
        if (string.IsNullOrWhiteSpace(valor)) return null;
        return Pizza.FirstOrDefault(t => string.Equals(t, valor.Trim(), StringComparison.OrdinalIgnoreCase));
    }
}

public static class Categorias
{
    public const string Pizzas = "Pizzas";
    public const string Bebidas = "Bebidas";
    public const string Adiciones = "Adiciones";

    public static readonly string[] Validas = [Pizzas, Bebidas, Adiciones];

    public static string? Normalizar(string? valor) =>
        Validas.FirstOrDefault(c => string.Equals(c, valor?.Trim(), StringComparison.OrdinalIgnoreCase));
}

public static class EstadosPedido
{
    public const string Pendiente = "Pendiente";
    public const string Confirmado = "Confirmado";
    public const string EnPreparacion = "En preparación";
    public const string Listo = "Listo para entregar";
    public const string Entregado = "Entregado";
    public const string Cancelado = "Cancelado";

    public static readonly string[] Todos = [Pendiente, Confirmado, EnPreparacion, Listo, Entregado, Cancelado];

    /// <summary>Transiciones permitidas desde cada estado.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Transiciones = new Dictionary<string, string[]>
    {
        [Pendiente] = [Confirmado, Cancelado],
        [Confirmado] = [EnPreparacion, Cancelado],
        [EnPreparacion] = [Listo, Cancelado],
        [Listo] = [Entregado, Cancelado],
    };
}

public static class MediosPago
{
    public static readonly string[] Validos = ["Efectivo", "Tarjeta", "Transferencia"];

    public static string? Normalizar(string? valor) =>
        Validos.FirstOrDefault(m => string.Equals(m, valor?.Trim(), StringComparison.OrdinalIgnoreCase));
}
