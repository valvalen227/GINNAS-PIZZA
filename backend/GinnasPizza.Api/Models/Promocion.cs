namespace GinnasPizza.Api.Models;

/// <summary>Combo/promoción formada por productos existentes con un descuento.</summary>
public class Promocion
{
    public int Id { get; set; }

    public string Nombre { get; set; } = string.Empty;

    public string Descripcion { get; set; } = string.Empty;

    public string Emoji { get; set; } = "🎁";

    /// <summary>URL o data URL de la imagen del combo (opcional).</summary>
    public string Imagen { get; set; } = string.Empty;

    /// <summary>"general" (todos) o "clientes" (solo clientes registrados).</summary>
    public string Publico { get; set; } = "general";

    /// <summary>"precio" (precio especial), "fijo" (monto a descontar) o "porcentaje".</summary>
    public string TipoDescuento { get; set; } = "porcentaje";

    public decimal ValorDescuento { get; set; }

    public DateOnly? FechaInicio { get; set; }

    public DateOnly? FechaFin { get; set; }

    public bool Activa { get; set; } = true;

    public ICollection<PromocionComponente> Componentes { get; set; } = new List<PromocionComponente>();
}

public class PromocionComponente
{
    public int Id { get; set; }

    public int PromocionId { get; set; }

    public Promocion? Promocion { get; set; }

    public int ProductoId { get; set; }

    public Producto? Producto { get; set; }

    public string Tamano { get; set; } = string.Empty;

    public int Cantidad { get; set; } = 1;
}
