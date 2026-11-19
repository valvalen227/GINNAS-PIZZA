using GinnasPizza.Api.Contracts;
using GinnasPizza.Api.Data;
using GinnasPizza.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Services;

public sealed record ResultadoOperacion<T>(bool Ok, int Estado, string? Error, T? Valor)
{
    public static ResultadoOperacion<T> Exito(T valor, int estado = StatusCodes.Status200OK) => new(true, estado, null, valor);

    public static ResultadoOperacion<T> Falla(int estado, string error) => new(false, estado, error, default);
}

public sealed record DatosEntrega(string NombreRecibe, string Telefono, string Direccion, string Barrio, string Indicaciones);

/// <summary>Datos ya validados por el endpoint para crear un pedido.</summary>
public sealed class SolicitudPedido
{
    public required string Tipo { get; init; }
    public required string Canal { get; init; }
    public int? ClienteId { get; init; }
    public string Mesa { get; init; } = "";
    public DatosEntrega? Entrega { get; init; }
    public string Observaciones { get; init; } = "";
    public string MedioPagoSolicitado { get; init; } = "";
    public string NombreVisitante { get; init; } = "";
    public string CorreoVisitante { get; init; } = "";
    public required IReadOnlyList<LineaPedidoRequest> Lineas { get; init; }
    public required string Usuario { get; init; }
}

public interface IPedidoService
{
    Task<ResultadoOperacion<PedidoDto>> CrearAsync(SolicitudPedido solicitud, CancellationToken ct);

    Task<ResultadoOperacion<PedidoDto>> CambiarEstadoAsync(int pedidoId, string nuevoEstado, string usuario, CancellationToken ct);

    Task<ResultadoOperacion<PedidoDto>> RegistrarPagoAsync(int pedidoId, string medioPago, CancellationToken ct);
}

public sealed class PedidoService(AppDbContext db, IProductAvailabilityService disponibilidad) : IPedidoService
{
    private const int MaxLineas = 40;
    private const int MaxCantidadPorLinea = 50;

    public Task<ResultadoOperacion<PedidoDto>> CrearAsync(SolicitudPedido solicitud, CancellationToken ct) =>
        ConReintento(() => CrearInternoAsync(solicitud, ct));

    public Task<ResultadoOperacion<PedidoDto>> CambiarEstadoAsync(int pedidoId, string nuevoEstado, string usuario, CancellationToken ct) =>
        ConReintento(() => CambiarEstadoInternoAsync(pedidoId, nuevoEstado, usuario, ct));

    // ───────────────────────────── Crear pedido ─────────────────────────────

    private async Task<ResultadoOperacion<PedidoDto>> CrearInternoAsync(SolicitudPedido solicitud, CancellationToken ct)
    {
        if (solicitud.Lineas.Count == 0)
            return ResultadoOperacion<PedidoDto>.Falla(400, "El pedido no contiene productos.");
        if (solicitud.Lineas.Count > MaxLineas)
            return ResultadoOperacion<PedidoDto>.Falla(400, $"Un pedido admite como máximo {MaxLineas} líneas.");

        Cliente? cliente = null;
        if (solicitud.ClienteId is { } clienteId)
        {
            cliente = await db.Clientes.AsNoTracking().FirstOrDefaultAsync(c => c.Id == clienteId && c.Activo, ct);
            if (cliente is null)
                return ResultadoOperacion<PedidoDto>.Falla(400, "El cliente seleccionado no existe o está inactivo.");
        }

        var productoIds = solicitud.Lineas.Where(l => l.ProductoId.HasValue).Select(l => l.ProductoId!.Value).Distinct().ToList();
        var promocionIds = solicitud.Lineas.Where(l => l.PromocionId.HasValue).Select(l => l.PromocionId!.Value).Distinct().ToList();
        var productos = await db.Productos.AsNoTracking().Where(p => productoIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, ct);
        var promociones = await db.Promociones.AsNoTracking()
            .Include(p => p.Componentes).ThenInclude(c => c.Producto)
            .Where(p => promocionIds.Contains(p.Id))
            .ToDictionaryAsync(p => p.Id, ct);
        var hoy = TiempoColombia.Hoy();

        var detalles = new List<DetallePedido>();
        var consumo = new List<LineaConsumo>();

        foreach (var linea in solicitud.Lineas)
        {
            if (linea.Cantidad < 1 || linea.Cantidad > MaxCantidadPorLinea)
                return ResultadoOperacion<PedidoDto>.Falla(400, $"La cantidad de cada línea debe estar entre 1 y {MaxCantidadPorLinea}.");
            if (linea.ProductoId.HasValue == linea.PromocionId.HasValue)
                return ResultadoOperacion<PedidoDto>.Falla(400, "Cada línea debe indicar un producto o una promoción (no ambos).");

            if (linea.ProductoId is { } productoId)
            {
                if (!productos.TryGetValue(productoId, out var producto))
                    return ResultadoOperacion<PedidoDto>.Falla(400, $"El producto {productoId} no existe.");
                if (!producto.Disponible)
                    return ResultadoOperacion<PedidoDto>.Falla(409, $"{producto.Nombre} no está disponible.");

                string tamano;
                if (producto.EsPizza)
                {
                    var normalizado = Tamanos.Normalizar(linea.Tamano);
                    if (normalizado is null)
                        return ResultadoOperacion<PedidoDto>.Falla(400, $"Indica un tamaño válido (Personal, Mediana o Familiar) para {producto.Nombre}.");
                    tamano = normalizado;
                }
                else
                {
                    tamano = string.Empty;
                }

                // Precio real según el tamaño, calculado en el servidor (nunca se confía en el precio del cliente).
                var precio = producto.PrecioPara(tamano);
                if (precio is null)
                    return ResultadoOperacion<PedidoDto>.Falla(409, $"{producto.Nombre} no tiene precio para el tamaño {tamano}.");

                var unitario = PromocionCalculadora.Redondear(precio.Value);
                detalles.Add(new DetallePedido
                {
                    ProductoId = producto.Id,
                    Nombre = producto.Nombre,
                    Tamano = tamano,
                    Cantidad = linea.Cantidad,
                    PrecioNormalUnitario = unitario,
                    DescuentoUnitario = 0,
                    PrecioUnitario = unitario,
                    Subtotal = unitario * linea.Cantidad
                });
                consumo.Add(new LineaConsumo(producto.Id, tamano, linea.Cantidad));
            }
            else
            {
                var promocionId = linea.PromocionId!.Value;
                if (!promociones.TryGetValue(promocionId, out var promocion))
                    return ResultadoOperacion<PedidoDto>.Falla(400, $"La promoción {promocionId} no existe.");
                if (!PromocionCalculadora.Vigente(promocion, hoy))
                    return ResultadoOperacion<PedidoDto>.Falla(409, $"La promoción «{promocion.Nombre}» no está vigente.");
                if (promocion.Publico == "clientes" && cliente is null)
                    return ResultadoOperacion<PedidoDto>.Falla(403, $"La promoción «{promocion.Nombre}» es exclusiva para clientes registrados. Inicia sesión para usarla.");
                if (promocion.Componentes.Any(c => c.Producto is null || !c.Producto.Disponible))
                    return ResultadoOperacion<PedidoDto>.Falla(409, $"La promoción «{promocion.Nombre}» incluye un producto no disponible.");

                var calculo = PromocionCalculadora.Calcular(promocion);
                if (calculo is null)
                    return ResultadoOperacion<PedidoDto>.Falla(409, $"La promoción «{promocion.Nombre}» tiene una configuración inválida.");

                var (normal, descuento, final) = calculo.Value;
                detalles.Add(new DetallePedido
                {
                    PromocionId = promocion.Id,
                    Nombre = promocion.Nombre,
                    Tamano = string.Empty,
                    Cantidad = linea.Cantidad,
                    PrecioNormalUnitario = normal,
                    DescuentoUnitario = descuento,
                    PrecioUnitario = final,
                    Subtotal = final * linea.Cantidad
                });
                foreach (var componente in promocion.Componentes)
                {
                    consumo.Add(new LineaConsumo(componente.ProductoId, componente.Producto!.EsPizza ? componente.Tamano : string.Empty,
                        componente.Cantidad * linea.Cantidad));
                }
            }
        }

        // Valida recetas y existencias reales antes de aceptar el pedido.
        var plan = await disponibilidad.PlanificarConsumoAsync(consumo, ct);
        if (!plan.Ok)
            return ResultadoOperacion<PedidoDto>.Falla(409, plan.Error ?? "No hay existencias suficientes.");

        var (subtotal, descuentoTotal, iva, total) = PromocionCalculadora.Totales(
            detalles.Sum(d => d.PrecioNormalUnitario * d.Cantidad),
            detalles.Sum(d => d.DescuentoUnitario * d.Cantidad));

        var ahora = DateTime.UtcNow;
        var pedido = new Pedido
        {
            ClienteId = cliente?.Id,
            NombreCliente = cliente?.Nombre ?? solicitud.NombreVisitante,
            CorreoCliente = cliente?.Correo ?? solicitud.CorreoVisitante,
            Fecha = ahora,
            Estado = EstadosPedido.Pendiente,
            EstadoPago = "Pendiente",
            TipoPedido = solicitud.Tipo,
            Canal = solicitud.Canal,
            Mesa = solicitud.Mesa,
            MedioPagoSolicitado = solicitud.MedioPagoSolicitado,
            Observaciones = solicitud.Observaciones,
            DireccionEntrega = solicitud.Entrega?.Direccion ?? "",
            NombreRecibe = solicitud.Entrega?.NombreRecibe ?? "",
            TelefonoEntrega = solicitud.Entrega?.Telefono ?? "",
            BarrioEntrega = solicitud.Entrega?.Barrio ?? "",
            IndicacionesEntrega = solicitud.Entrega?.Indicaciones ?? "",
            Subtotal = subtotal,
            Descuento = descuentoTotal,
            Iva = iva,
            Total = total,
            InventarioDescontado = true,
            Detalles = detalles
        };
        db.Pedidos.Add(pedido);

        // Descuenta ingredientes y registra cada salida en el kardex dentro de la misma transacción.
        foreach (var item in plan.Items)
        {
            item.Ingrediente.StockActual -= item.Cantidad;
            item.Ingrediente.FechaActualizacion = ahora;
            db.MovimientosInventario.Add(new MovimientoInventario
            {
                IngredienteId = item.Ingrediente.Id,
                Tipo = "Salida",
                Cantidad = item.Cantidad,
                Motivo = "Descuento automático por pedido",
                Fecha = ahora,
                Pedido = pedido,
                Usuario = solicitud.Usuario
            });
        }

        await db.SaveChangesAsync(ct); // una sola transacción: pedido + detalles + stock + movimientos
        return ResultadoOperacion<PedidoDto>.Exito(PedidoDto.De(pedido), StatusCodes.Status201Created);
    }

    // ───────────────────────────── Cambio de estado ─────────────────────────────

    private async Task<ResultadoOperacion<PedidoDto>> CambiarEstadoInternoAsync(int pedidoId, string nuevoEstado, string usuario, CancellationToken ct)
    {
        var pedido = await db.Pedidos.Include(p => p.Cliente).Include(p => p.Detalles).FirstOrDefaultAsync(p => p.Id == pedidoId, ct);
        if (pedido is null) return ResultadoOperacion<PedidoDto>.Falla(404, "El pedido no existe.");
        if (!EstadosPedido.Todos.Contains(nuevoEstado))
            return ResultadoOperacion<PedidoDto>.Falla(400, "El estado indicado no es válido.");
        if (!EstadosPedido.Transiciones.TryGetValue(pedido.Estado, out var permitidos) || !permitidos.Contains(nuevoEstado))
            return ResultadoOperacion<PedidoDto>.Falla(409, $"No se puede pasar un pedido de «{pedido.Estado}» a «{nuevoEstado}».");
        if (nuevoEstado == EstadosPedido.Cancelado && pedido.EstadoPago == "Pagado")
            return ResultadoOperacion<PedidoDto>.Falla(409, "No se puede cancelar un pedido pagado sin procesar primero un reembolso.");

        pedido.Estado = nuevoEstado;

        if (nuevoEstado == EstadosPedido.Cancelado && pedido.InventarioDescontado)
        {
            // Devuelve al inventario lo que realmente se descontó (salidas menos devoluciones previas).
            var movimientos = await db.MovimientosInventario
                .Where(m => m.PedidoId == pedido.Id && (m.Tipo == "Salida" || m.Tipo == "Entrada"))
                .ToListAsync(ct);
            var neto = movimientos
                .GroupBy(m => m.IngredienteId)
                .Select(g => (IngredienteId: g.Key, Cantidad: g.Sum(m => m.Tipo == "Salida" ? m.Cantidad : -m.Cantidad)))
                .Where(x => x.Cantidad > 0)
                .ToList();
            var ids = neto.Select(x => x.IngredienteId).ToList();
            var ingredientes = await db.Ingredientes.Where(i => ids.Contains(i.Id)).ToDictionaryAsync(i => i.Id, ct);
            var ahora = DateTime.UtcNow;
            foreach (var (ingredienteId, cantidad) in neto)
            {
                if (!ingredientes.TryGetValue(ingredienteId, out var ingrediente)) continue;
                ingrediente.StockActual += cantidad;
                ingrediente.FechaActualizacion = ahora;
                db.MovimientosInventario.Add(new MovimientoInventario
                {
                    IngredienteId = ingredienteId,
                    Tipo = "Entrada",
                    Cantidad = cantidad,
                    Motivo = "Devolución por cancelación del pedido",
                    Fecha = ahora,
                    PedidoId = pedido.Id,
                    Usuario = usuario
                });
            }
            pedido.InventarioDescontado = false;
        }

        await db.SaveChangesAsync(ct);
        return ResultadoOperacion<PedidoDto>.Exito(PedidoDto.De(pedido));
    }

    // ───────────────────────────── Pago ─────────────────────────────

    public async Task<ResultadoOperacion<PedidoDto>> RegistrarPagoAsync(int pedidoId, string medioPago, CancellationToken ct)
    {
        var medio = MediosPago.Normalizar(medioPago);
        if (medio is null)
            return ResultadoOperacion<PedidoDto>.Falla(400, "Selecciona un medio de pago válido (Efectivo, Tarjeta o Transferencia).");

        var pedido = await db.Pedidos.Include(p => p.Cliente).Include(p => p.Detalles).FirstOrDefaultAsync(p => p.Id == pedidoId, ct);
        if (pedido is null) return ResultadoOperacion<PedidoDto>.Falla(404, "El pedido no existe.");
        if (pedido.Estado == EstadosPedido.Cancelado)
            return ResultadoOperacion<PedidoDto>.Falla(409, "No se puede cobrar un pedido cancelado.");
        if (pedido.EstadoPago == "Pagado")
            return ResultadoOperacion<PedidoDto>.Falla(409, "Este pedido ya tiene el pago registrado.");

        var ahora = DateTime.UtcNow;
        pedido.EstadoPago = "Pagado";
        pedido.MedioPago = medio;
        pedido.FechaPago = ahora;
        db.Ventas.Add(new Venta
        {
            Pedido = pedido,
            Fecha = ahora,
            Subtotal = pedido.Subtotal,
            Descuento = pedido.Descuento,
            Iva = pedido.Iva,
            Total = pedido.Total,
            MedioPago = medio,
            Estado = "Completada"
        });

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // El índice único de Ventas.PedidoId impide cobrar dos veces el mismo pedido en peticiones simultáneas.
            return ResultadoOperacion<PedidoDto>.Falla(409, "Este pedido ya tiene el pago registrado.");
        }
        return ResultadoOperacion<PedidoDto>.Exito(PedidoDto.De(pedido));
    }

    // ───────────────────────────── Concurrencia ─────────────────────────────

    /// <summary>
    /// Reintenta la operación si otro pedido modificó el mismo stock al mismo tiempo (concurrencia optimista).
    /// Cada reintento vuelve a leer las existencias actuales.
    /// </summary>
    private async Task<ResultadoOperacion<PedidoDto>> ConReintento(Func<Task<ResultadoOperacion<PedidoDto>>> operacion)
    {
        const int maxIntentos = 8;
        for (var intento = 1; ; intento++)
        {
            try
            {
                return await operacion();
            }
            catch (DbUpdateConcurrencyException) when (intento < maxIntentos)
            {
                db.ChangeTracker.Clear();
                // Espera aleatoria creciente para que las peticiones en conflicto no choquen otra vez a la vez.
                await Task.Delay(Random.Shared.Next(5, 25 * intento));
            }
            catch (DbUpdateConcurrencyException)
            {
                db.ChangeTracker.Clear();
                return ResultadoOperacion<PedidoDto>.Falla(409, "El inventario cambió mientras se procesaba la solicitud. Inténtalo de nuevo.");
            }
        }
    }
}
