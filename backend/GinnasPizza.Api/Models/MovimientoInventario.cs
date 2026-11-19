namespace GinnasPizza.Api.Models;

public class MovimientoInventario
{
    public int Id { get; set; }

    public int IngredienteId { get; set; }

    public Ingrediente? Ingrediente { get; set; }

    /// <summary>"Entrada", "Salida" o "Ajuste".</summary>
    public string Tipo { get; set; } = string.Empty;

    /// <summary>Cantidad positiva para Entrada/Salida. En un Ajuste lleva signo (diferencia aplicada).</summary>
    public decimal Cantidad { get; set; }

    public string Motivo { get; set; } = string.Empty;

    public DateTime Fecha { get; set; } = DateTime.UtcNow;

    public int? PedidoId { get; set; }

    public Pedido? Pedido { get; set; }

    public string Usuario { get; set; } = string.Empty;
}
