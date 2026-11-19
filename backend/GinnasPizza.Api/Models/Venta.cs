namespace GinnasPizza.Api.Models;

/// <summary>Venta cerrada al registrar el pago de un pedido (una por pedido).</summary>
public class Venta
{
    public int Id { get; set; }

    public int PedidoId { get; set; }

    public Pedido? Pedido { get; set; }

    public DateTime Fecha { get; set; } = DateTime.UtcNow;

    public decimal Subtotal { get; set; }

    public decimal Descuento { get; set; }

    public decimal Iva { get; set; }

    public decimal Total { get; set; }

    public string MedioPago { get; set; } = string.Empty;

    public string Estado { get; set; } = "Completada";
}
