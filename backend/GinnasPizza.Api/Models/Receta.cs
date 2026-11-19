namespace GinnasPizza.Api.Models;

/// <summary>Cantidad de un ingrediente que consume una unidad de un producto en un tamaño dado.</summary>
public class Receta
{
    public int Id { get; set; }

    public int ProductoId { get; set; }

    public Producto? Producto { get; set; }

    public int IngredienteId { get; set; }

    public Ingrediente? Ingrediente { get; set; }

    /// <summary>"Personal", "Mediana" o "Familiar" para pizzas; cadena vacía para el resto.</summary>
    public string Tamano { get; set; } = string.Empty;

    public decimal Cantidad { get; set; }
}
