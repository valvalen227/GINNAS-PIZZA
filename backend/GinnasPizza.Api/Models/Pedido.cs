namespace GinnasPizza.Api.Models;

public class Pedido
{
    public int Id { get; set; }

    /// <summary>Cliente registrado (null para visitantes o ventas de mostrador).</summary>
    public int? ClienteId { get; set; }

    public Cliente? Cliente { get; set; }

    public string NombreCliente { get; set; } = string.Empty;

    public string CorreoCliente { get; set; } = string.Empty;

    public DateTime Fecha { get; set; } = DateTime.UtcNow;

    public string Estado { get; set; } = EstadosPedido.Pendiente;

    /// <summary>Suma de precios normales (antes de descuentos e IVA).</summary>
    public decimal Subtotal { get; set; }

    public decimal Descuento { get; set; }

    /// <summary>IVA (16 %) calculado sobre Subtotal - Descuento.</summary>
    public decimal Iva { get; set; }

    public decimal Total { get; set; }

    /// <summary>"Domicilio", "Recoger" o "Mesa".</summary>
    public string TipoPedido { get; set; } = "Domicilio";

    /// <summary>"Web", "Mostrador" o "Mesa".</summary>
    public string Canal { get; set; } = "Web";

    public string Mesa { get; set; } = string.Empty;

    public string DireccionEntrega { get; set; } = string.Empty;

    public string NombreRecibe { get; set; } = string.Empty;

    public string TelefonoEntrega { get; set; } = string.Empty;

    public string BarrioEntrega { get; set; } = string.Empty;

    public string IndicacionesEntrega { get; set; } = string.Empty;

    public string Observaciones { get; set; } = string.Empty;

    public string EstadoPago { get; set; } = "Pendiente";

    /// <summary>Medio que el cliente dijo que usará (no confirma el pago).</summary>
    public string MedioPagoSolicitado { get; set; } = string.Empty;

    /// <summary>Medio de pago realmente registrado al cobrar.</summary>
    public string MedioPago { get; set; } = string.Empty;

    public DateTime? FechaPago { get; set; }

    /// <summary>True mientras los ingredientes del pedido estén descontados del inventario.</summary>
    public bool InventarioDescontado { get; set; }

    public ICollection<DetallePedido> Detalles { get; set; } = new List<DetallePedido>();

    public Venta? Venta { get; set; }
}
