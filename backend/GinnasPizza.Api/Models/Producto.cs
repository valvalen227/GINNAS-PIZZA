namespace GinnasPizza.Api.Models;

public class Producto
{
    public int Id { get; set; }

    public string Nombre { get; set; } = string.Empty;

    public string Descripcion { get; set; } = string.Empty;

    /// <summary>Precio base. Para pizzas es el precio del tamaño Personal.</summary>
    public decimal Precio { get; set; }

    /// <summary>Precio del tamaño Mediana (solo pizzas).</summary>
    public decimal? PrecioMediana { get; set; }

    /// <summary>Precio del tamaño Familiar (solo pizzas).</summary>
    public decimal? PrecioFamiliar { get; set; }

    public string Categoria { get; set; } = Categorias.Pizzas;

    public bool Disponible { get; set; } = true;

    public string Emoji { get; set; } = "🍕";

    /// <summary>Imagen del producto como data URL o URL externa (opcional).</summary>
    public string Imagen { get; set; } = string.Empty;

    /// <summary>Presentación para productos que no son pizza (ej. "600 ml").</summary>
    public string Presentacion { get; set; } = string.Empty;

    public DateTime FechaCreacion { get; set; } = DateTime.UtcNow;

    public ICollection<Receta> Recetas { get; set; } = new List<Receta>();

    public bool EsPizza => string.Equals(Categoria, Categorias.Pizzas, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Precio unitario real según el tamaño. Para pizzas el tamaño es obligatorio;
    /// devuelve null si el tamaño no es válido o no tiene precio configurado.
    /// </summary>
    public decimal? PrecioPara(string? tamano)
    {
        if (!EsPizza) return Precio;
        return Tamanos.Normalizar(tamano) switch
        {
            Tamanos.Personal => Precio,
            Tamanos.Mediana => PrecioMediana,
            Tamanos.Familiar => PrecioFamiliar,
            _ => null
        };
    }
}
