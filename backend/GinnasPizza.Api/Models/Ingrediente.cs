namespace GinnasPizza.Api.Models;

public class Ingrediente
{
    public int Id { get; set; }

    public string Nombre { get; set; } = string.Empty;

    public string Categoria { get; set; } = "Otros";

    public string UnidadMedida { get; set; } = string.Empty;

    public decimal StockActual { get; set; }

    public decimal StockMinimo { get; set; }

    public decimal CostoUnitario { get; set; }

    public int? ProveedorId { get; set; }

    public Proveedor? Proveedor { get; set; }

    public DateOnly? FechaVencimiento { get; set; }

    public string Observaciones { get; set; } = string.Empty;

    public bool Activo { get; set; } = true;

    public DateTime FechaActualizacion { get; set; } = DateTime.UtcNow;

    /// <summary>Columna de sistema xmin de PostgreSQL usada como token de concurrencia optimista.</summary>
    public uint Version { get; set; }
}
