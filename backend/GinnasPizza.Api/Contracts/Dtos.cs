using GinnasPizza.Api.Models;
using GinnasPizza.Api.Services;

namespace GinnasPizza.Api.Contracts;

// ───────────────────────────── Respuestas ─────────────────────────────

public sealed record UsuarioDto(int Id, string Nombre, string Correo, string Rol, bool Activo, DateTime FechaCreacion)
{
    public static UsuarioDto De(Usuario u) => new(u.Id, u.Nombre, u.Correo, u.Rol, u.Activo, u.FechaCreacion);
}

public sealed record ClienteDto(int Id, string Nombre, string Identificacion, string Correo, string Telefono,
    string Direccion, bool Activo, DateTime FechaRegistro)
{
    public static ClienteDto De(Cliente c) =>
        new(c.Id, c.Nombre, c.Identificacion, c.Correo, c.Telefono, c.Direccion, c.Activo, c.FechaRegistro);
}

public sealed record RecetaIngredienteDto(int IngredienteId, string Nombre, string Unidad, decimal Cantidad);

public sealed record RecetaTamanoDto(string Tamano, List<RecetaIngredienteDto> Ingredientes);

public sealed record ProductoDto(int Id, string Nombre, string Descripcion, decimal Precio, decimal? PrecioMediana,
    decimal? PrecioFamiliar, string Categoria, bool Disponible, string Emoji, string Imagen, string Presentacion,
    List<RecetaTamanoDto>? Recetas)
{
    public static ProductoDto De(Producto p, bool incluirRecetas)
    {
        List<RecetaTamanoDto>? recetas = null;
        if (incluirRecetas)
        {
            recetas = p.Recetas
                .GroupBy(r => r.Tamano)
                .OrderBy(g => Array.IndexOf(Tamanos.Pizza, g.Key))
                .Select(g => new RecetaTamanoDto(g.Key, g
                    .OrderBy(r => r.Ingrediente?.Nombre)
                    .Select(r => new RecetaIngredienteDto(r.IngredienteId, r.Ingrediente?.Nombre ?? "", r.Ingrediente?.UnidadMedida ?? "", r.Cantidad))
                    .ToList()))
                .ToList();
        }
        return new ProductoDto(p.Id, p.Nombre, p.Descripcion, p.Precio, p.PrecioMediana, p.PrecioFamiliar,
            p.Categoria, p.Disponible, p.Emoji, p.Imagen, p.Presentacion, recetas);
    }
}

public sealed record IngredienteDto(int Id, string Nombre, string Categoria, string Unidad, decimal Cantidad,
    decimal Minimo, decimal CostoUnidad, int? ProveedorId, string Proveedor, DateOnly? Vencimiento,
    string Observaciones, bool Activo, DateTime FechaActualizacion)
{
    public static IngredienteDto De(Ingrediente i) =>
        new(i.Id, i.Nombre, i.Categoria, i.UnidadMedida, i.StockActual, i.StockMinimo, i.CostoUnitario,
            i.ProveedorId, i.Proveedor?.Nombre ?? "", i.FechaVencimiento, i.Observaciones, i.Activo, i.FechaActualizacion);
}

public sealed record MovimientoDto(int Id, int IngredienteId, string Ingrediente, string Unidad, string Tipo,
    decimal Cantidad, string Motivo, DateTime Fecha, int? PedidoId, string PedidoCodigo, string Usuario)
{
    public static MovimientoDto De(MovimientoInventario m) =>
        new(m.Id, m.IngredienteId, m.Ingrediente?.Nombre ?? "", m.Ingrediente?.UnidadMedida ?? "", m.Tipo,
            m.Cantidad, m.Motivo, m.Fecha, m.PedidoId, m.PedidoId is { } id ? $"#P-{id}" : "", m.Usuario);
}

public sealed record PromocionComponenteDto(int ProductoId, string Producto, string Tamano, int Cantidad);

public sealed record PromocionDto(int Id, string Nombre, string Descripcion, string Emoji, string Publico,
    string TipoDescuento, decimal ValorDescuento, DateOnly? FechaInicio, DateOnly? FechaFin, bool Activa,
    bool Vigente, List<PromocionComponenteDto> Componentes, decimal? PrecioNormal, decimal? Descuento, decimal? PrecioFinal, string Imagen);

public sealed record ProveedorDto(int Id, string Nombre, string Empresa, string Identificacion, string Telefono,
    string Correo, string Direccion, string Productos, string Observaciones, bool Activo)
{
    public static ProveedorDto De(Proveedor p) =>
        new(p.Id, p.Nombre, p.Empresa, p.Identificacion, p.Telefono, p.Correo, p.Direccion, p.Productos, p.Observaciones, p.Activo);
}

public sealed record LineaPedidoDto(int? ProductoId, int? PromocionId, string Nombre, string Tamano, int Cantidad,
    decimal PrecioUnitario, decimal PrecioNormalUnitario, decimal DescuentoUnitario)
{
    public static LineaPedidoDto De(DetallePedido d) =>
        new(d.ProductoId, d.PromocionId, d.Nombre, d.Tamano, d.Cantidad, d.PrecioUnitario, d.PrecioNormalUnitario, d.DescuentoUnitario);
}

public sealed record PedidoDto(int Id, string Codigo, string Cliente, string ClienteCorreo, DateTime Fecha, string Tipo,
    string Canal, string Mesa, string Estado, string EstadoPago, decimal Subtotal, decimal Descuento, decimal Iva,
    decimal Total, string MetodoPago, string MedioPagoSolicitado, DateTime? FechaPago, string DireccionEntrega,
    string NombreRecibe, string TelefonoEntrega, string BarrioEntrega, string IndicacionesEntrega, string Observaciones,
    List<LineaPedidoDto> Productos)
{
    public static PedidoDto De(Pedido p) =>
        new(p.Id, $"#P-{p.Id}",
            p.Cliente?.Nombre ?? (string.IsNullOrWhiteSpace(p.NombreCliente) ? "Cliente mostrador" : p.NombreCliente),
            p.Cliente?.Correo ?? p.CorreoCliente, p.Fecha, p.TipoPedido, p.Canal, p.Mesa, p.Estado, p.EstadoPago,
            p.Subtotal, p.Descuento, p.Iva, p.Total, p.MedioPago, p.MedioPagoSolicitado, p.FechaPago,
            p.DireccionEntrega, p.NombreRecibe, p.TelefonoEntrega, p.BarrioEntrega, p.IndicacionesEntrega,
            p.Observaciones, p.Detalles.OrderBy(d => d.Id).Select(LineaPedidoDto.De).ToList());
}

public sealed record VentaDto(int Id, string Codigo, int PedidoId, string PedidoCodigo, DateTime Fecha, string Cliente,
    string ClienteCorreo, string Tipo, decimal Subtotal, decimal Descuento, decimal Iva, decimal Total, string MetodoPago,
    string Estado, List<LineaPedidoDto> Productos)
{
    public static VentaDto De(Venta v)
    {
        var p = v.Pedido!;
        return new VentaDto(v.Id, $"#V-{v.PedidoId}", v.PedidoId, $"#P-{v.PedidoId}", v.Fecha,
            p.Cliente?.Nombre ?? (string.IsNullOrWhiteSpace(p.NombreCliente) ? "Cliente mostrador" : p.NombreCliente),
            p.Cliente?.Correo ?? p.CorreoCliente, p.TipoPedido, v.Subtotal, v.Descuento, v.Iva, v.Total, v.MedioPago,
            v.Estado, p.Detalles.OrderBy(d => d.Id).Select(LineaPedidoDto.De).ToList());
    }
}

// ───────────────────────────── Solicitudes ─────────────────────────────

public sealed record LoginRequest(string? Correo, string? Password);

public sealed record RegistroClienteRequest(string? Nombre, string? Correo, string? Password, string? Telefono);

public sealed record ClienteRequest(string? Nombre, string? Identificacion, string? Correo, string? Telefono,
    string? Direccion, bool? Activo);

public sealed record RecetaIngredienteRequest(int IngredienteId, decimal Cantidad);

public sealed record RecetaTamanoRequest(string? Tamano, List<RecetaIngredienteRequest>? Ingredientes);

public sealed record ProductoRequest(string? Nombre, string? Descripcion, decimal Precio, decimal? PrecioMediana,
    decimal? PrecioFamiliar, string? Categoria, bool? Disponible, string? Emoji, string? Imagen, string? Presentacion,
    List<RecetaTamanoRequest>? Recetas);

/// <summary>
/// <c>Cantidad</c> es la existencia deseada: al crear, el stock inicial (0 si no viene); al editar, si es null
/// no se toca el stock (así editar otros datos nunca pisa descuentos hechos por pedidos recientes).
/// </summary>
public sealed record IngredienteRequest(string? Nombre, string? Categoria, string? Unidad, decimal? Cantidad,
    decimal Minimo, decimal? CostoUnidad, int? ProveedorId, DateOnly? Vencimiento, string? Observaciones, bool? Activo);

public sealed record MovimientoRequest(int IngredienteId, string? Tipo, decimal Cantidad, string? Motivo);

public sealed record ComponentePromocionRequest(int ProductoId, string? Tamano, int Cantidad);

public sealed record PromocionRequest(string? Nombre, string? Descripcion, string? Emoji, string? Publico,
    string? TipoDescuento, decimal ValorDescuento, DateOnly? FechaInicio, DateOnly? FechaFin, bool? Activa,
    List<ComponentePromocionRequest>? Componentes, string? Imagen = null);

public sealed record EstadoActivoRequest(bool Activa);

public sealed record ProveedorRequest(string? Nombre, string? Empresa, string? Identificacion, string? Telefono,
    string? Correo, string? Direccion, string? Productos, string? Observaciones, bool? Activo);

public sealed record UsuarioRequest(string? Nombre, string? Correo, string? Password, string? Rol, bool? Activo);

public sealed record PasswordRequest(string? Password);

public sealed record LineaPedidoRequest(int? ProductoId, int? PromocionId, string? Tamano, int Cantidad);

public sealed record PedidoWebRequest(string? Tipo, string? Cliente, string? ClienteCorreo, string? NombreRecibe,
    string? TelefonoEntrega, string? DireccionEntrega, string? BarrioEntrega, string? IndicacionesEntrega,
    string? Observaciones, string? MedioPagoSolicitado, List<LineaPedidoRequest>? Productos);

public sealed record PedidoInternoRequest(string? Tipo, int? ClienteId, string? Mesa, string? Observaciones,
    List<LineaPedidoRequest>? Productos);

public sealed record CambioEstadoRequest(string? Estado);

public sealed record PagoRequest(string? MedioPago);
