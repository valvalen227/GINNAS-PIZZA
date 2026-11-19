using GinnasPizza.Api.Contracts;
using GinnasPizza.Api.Data;
using GinnasPizza.Api.Models;
using GinnasPizza.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Endpoints;

public static class PedidosEndpoints
{
    public static WebApplication MapPedidos(this WebApplication app)
    {
        // ── Pedido desde la tienda web (público; si hay sesión de cliente se asocia a su cuenta) ──
        app.MapPost("/api/pedidos/web", async (PedidoWebRequest s, IPedidoService pedidos, HttpContext http, CancellationToken ct) =>
        {
            var tipo = Util.Limpiar(s.Tipo, 20);
            if (tipo is not ("Domicilio" or "Recoger"))
                return Util.Error(400, "Solo se aceptan pedidos web de domicilio o recoger.");

            DatosEntrega? entrega = null;
            var medioPago = string.Empty;
            if (tipo == "Domicilio")
            {
                var nombreRecibe = Util.Limpiar(s.NombreRecibe, 120);
                var telefono = Util.Limpiar(s.TelefonoEntrega, 25);
                var direccion = Util.Limpiar(s.DireccionEntrega, 180);
                var barrio = Util.Limpiar(s.BarrioEntrega, 100);
                medioPago = MediosPago.Normalizar(s.MedioPagoSolicitado) ?? string.Empty;
                if (nombreRecibe.Length < 2) return Util.Error(400, "Ingresa el nombre de quien recibe el pedido.");
                if (!Util.TelefonoValido(telefono)) return Util.Error(400, "Ingresa un teléfono válido con entre 7 y 15 dígitos.");
                if (direccion.Length < 5) return Util.Error(400, "Ingresa una dirección completa para la entrega.");
                if (barrio.Length < 2) return Util.Error(400, "Ingresa el barrio de la entrega.");
                if (medioPago.Length == 0) return Util.Error(400, "Selecciona el medio de pago previsto.");
                entrega = new DatosEntrega(nombreRecibe, telefono, direccion, barrio, Util.Limpiar(s.IndicacionesEntrega, 240));
            }

            var sesion = await http.SesionOpcionalAsync();
            var correoVisitante = Util.NormalizarCorreo(s.ClienteCorreo);
            var solicitud = new SolicitudPedido
            {
                Tipo = tipo,
                Canal = "Web",
                ClienteId = sesion?.Rol == Roles.Cliente ? sesion.Id : null,
                Entrega = entrega,
                MedioPagoSolicitado = medioPago,
                Observaciones = Util.Limpiar(s.Observaciones, 300),
                NombreVisitante = Util.Limpiar(s.Cliente, 120) is { Length: > 0 } nombre ? nombre : "Cliente visitante",
                CorreoVisitante = Util.CorreoValido(correoVisitante) ? correoVisitante : string.Empty,
                Lineas = s.Productos ?? [],
                Usuario = sesion?.Correo ?? "Tienda web"
            };

            var resultado = await pedidos.CrearAsync(solicitud, ct);
            return resultado.Ok
                ? Results.Created($"/api/pedidos/{resultado.Valor!.Id}", new
                {
                    pedidoId = resultado.Valor.Id,
                    codigo = resultado.Valor.Codigo,
                    estado = resultado.Valor.Estado,
                    tipo = resultado.Valor.Tipo,
                    canal = "Web",
                    subtotal = resultado.Valor.Subtotal,
                    descuento = resultado.Valor.Descuento,
                    iva = resultado.Valor.Iva,
                    total = resultado.Valor.Total
                })
                : Util.Error(resultado.Estado, resultado.Error!);
        })
        .WithName("CrearPedidoWeb");

        // ── Pedido interno (mesa o mostrador) ──
        app.MapPost("/api/pedidos", async (PedidoInternoRequest s, IPedidoService pedidos, HttpContext http, CancellationToken ct) =>
        {
            var sesion = http.Sesion();
            var tipo = Util.Limpiar(s.Tipo, 20);
            if (tipo is not ("Mesa" or "Recoger"))
                return Util.Error(400, "Los pedidos internos solo pueden ser de mesa o para llevar; los domicilios se piden desde la web.");
            if (sesion.Rol == Roles.Mesera && tipo != "Mesa")
                return Util.Error(403, "El personal de mesas solo registra pedidos de mesa.");
            if (sesion.Rol == Roles.Cajero && tipo != "Recoger")
                return Util.Error(403, "El personal de caja solo registra pedidos para llevar.");

            var mesa = Util.Limpiar(s.Mesa, 20);
            if (tipo == "Mesa" && mesa.Length == 0) return Util.Error(400, "Indica la mesa del pedido.");

            var solicitud = new SolicitudPedido
            {
                Tipo = tipo,
                Canal = tipo == "Mesa" ? "Mesa" : "Mostrador",
                ClienteId = s.ClienteId,
                Mesa = tipo == "Mesa" ? mesa : string.Empty,
                Observaciones = Util.Limpiar(s.Observaciones, 300),
                NombreVisitante = "Cliente mostrador",
                Lineas = s.Productos ?? [],
                Usuario = sesion.Correo
            };
            var resultado = await pedidos.CrearAsync(solicitud, ct);
            return resultado.Ok
                ? Results.Created($"/api/pedidos/{resultado.Valor!.Id}", resultado.Valor)
                : Util.Error(resultado.Estado, resultado.Error!);
        })
        .RequireRoles(Roles.Administrador, Roles.Cajero, Roles.Mesera)
        .WithName("CrearPedidoInterno");

        app.MapGet("/api/pedidos", async (string? desde, string? hasta, string? estado, int? limite, AppDbContext db, CancellationToken ct) =>
        {
            var consulta = db.Pedidos.AsNoTracking().Include(p => p.Cliente).Include(p => p.Detalles).AsQueryable();
            if (TiempoColombia.TryParseDia(desde, out var dDesde)) consulta = consulta.Where(p => p.Fecha >= TiempoColombia.InicioDiaUtc(dDesde));
            if (TiempoColombia.TryParseDia(hasta, out var dHasta)) consulta = consulta.Where(p => p.Fecha <= TiempoColombia.FinDiaUtc(dHasta));
            if (!string.IsNullOrWhiteSpace(estado)) consulta = consulta.Where(p => p.Estado == estado);

            var lista = await consulta.OrderByDescending(p => p.Fecha).Take(Math.Clamp(limite ?? 500, 1, 2000)).ToListAsync(ct);
            return Results.Ok(lista.Select(PedidoDto.De));
        })
        .RequireRoles(Roles.Administrador, Roles.Cajero, Roles.Mesera)
        .WithName("ListarPedidos");

        app.MapGet("/api/pedidos/{id:int}", async (int id, AppDbContext db, CancellationToken ct) =>
        {
            var pedido = await db.Pedidos.AsNoTracking().Include(p => p.Cliente).Include(p => p.Detalles).FirstOrDefaultAsync(p => p.Id == id, ct);
            return pedido is null ? Util.Error(404, "El pedido no existe.") : Results.Ok(PedidoDto.De(pedido));
        })
        .RequireRoles(Roles.Administrador, Roles.Cajero, Roles.Mesera);

        app.MapPatch("/api/pedidos/{id:int}/estado", async (int id, CambioEstadoRequest s, IPedidoService pedidos, HttpContext http, CancellationToken ct) =>
        {
            var resultado = await pedidos.CambiarEstadoAsync(id, Util.Limpiar(s.Estado, 40), http.Sesion().Correo, ct);
            return resultado.Ok ? Results.Ok(resultado.Valor) : Util.Error(resultado.Estado, resultado.Error!);
        })
        .RequireRoles(Roles.Administrador, Roles.Cajero, Roles.Mesera)
        .WithName("CambiarEstadoPedido");

        app.MapPost("/api/pedidos/{id:int}/pago", async (int id, PagoRequest s, IPedidoService pedidos, CancellationToken ct) =>
        {
            var resultado = await pedidos.RegistrarPagoAsync(id, s.MedioPago ?? string.Empty, ct);
            return resultado.Ok ? Results.Ok(resultado.Valor) : Util.Error(resultado.Estado, resultado.Error!);
        })
        .RequireRoles(Roles.Administrador, Roles.Cajero)
        .WithName("RegistrarPagoPedido");

        // ── Ventas (pedidos cobrados) ──
        app.MapGet("/api/ventas", async (string? desde, string? hasta, int? limite, AppDbContext db, CancellationToken ct) =>
        {
            var consulta = db.Ventas.AsNoTracking()
                .Include(v => v.Pedido).ThenInclude(p => p!.Cliente)
                .Include(v => v.Pedido).ThenInclude(p => p!.Detalles)
                .AsQueryable();
            if (TiempoColombia.TryParseDia(desde, out var dDesde)) consulta = consulta.Where(v => v.Fecha >= TiempoColombia.InicioDiaUtc(dDesde));
            if (TiempoColombia.TryParseDia(hasta, out var dHasta)) consulta = consulta.Where(v => v.Fecha <= TiempoColombia.FinDiaUtc(dHasta));

            var lista = await consulta.OrderByDescending(v => v.Fecha).Take(Math.Clamp(limite ?? 1000, 1, 5000)).ToListAsync(ct);
            return Results.Ok(lista.Select(VentaDto.De));
        })
        .RequireRoles(Roles.Administrador, Roles.Cajero)
        .WithName("ListarVentas");

        return app;
    }
}
