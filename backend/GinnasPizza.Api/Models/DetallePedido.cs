namespace GinnasPizza.Api.Models;

public class DetallePedido
{
    public int Id { get; set; }

    public int PedidoId { get; set; }

    public Pedido? Pedido { get; set; }

    /// <summary>Producto vendido (null si la línea es un combo/promoción).</summary>
    public int? ProductoId { get; set; }

    public Producto? Producto { get; set; }

    /// <summary>Promoción vendida como combo (null si la línea es un producto).</summary>
    public int? PromocionId { get; set; }

    public Promocion? Promocion { get; set; }

    /// <summary>Nombre del producto o combo al momento de la venta.</summary>
    public string Nombre { get; set; } = string.Empty;

    public int Cantidad { get; set; }

    public string Tamano { get; set; } = string.Empty;

    /// <summary>Precio unitario sin descuento.</summary>
    public decimal PrecioNormalUnitario { get; set; }

    public decimal DescuentoUnitario { get; set; }

    /// <summary>Precio unitario final cobrado (normal - descuento).</summary>
    public decimal PrecioUnitario { get; set; }

    /// <summary>PrecioUnitario * Cantidad.</summary>
    public decimal Subtotal { get; set; }
}
