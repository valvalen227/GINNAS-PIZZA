using GinnasPizza.Api.Models;

namespace GinnasPizza.Api.Services;

/// <summary>Reglas de vigencia y cálculo de precio de promociones/combos (única fuente de verdad en el servidor).</summary>
public static class PromocionCalculadora
{
    public const decimal TasaIva = 0.16m;

    public static decimal Redondear(decimal valor) => decimal.Round(valor, 2, MidpointRounding.AwayFromZero);

    public static bool Vigente(Promocion promocion, DateOnly hoy) =>
        promocion.Activa
        && (promocion.FechaInicio is null || promocion.FechaInicio <= hoy)
        && (promocion.FechaFin is null || promocion.FechaFin >= hoy);

    /// <summary>
    /// Calcula precio normal, descuento y precio final de un combo. Requiere los componentes con su producto cargado.
    /// Devuelve null si algún componente no tiene precio válido para su tamaño.
    /// </summary>
    public static (decimal Normal, decimal Descuento, decimal Final)? Calcular(Promocion promocion)
    {
        if (promocion.Componentes.Count == 0) return null;
        decimal normal = 0;
        foreach (var componente in promocion.Componentes)
        {
            var precio = componente.Producto?.PrecioPara(componente.Tamano);
            if (precio is null || componente.Cantidad <= 0) return null;
            normal += precio.Value * componente.Cantidad;
        }
        normal = Redondear(normal);

        var valor = Math.Max(0, promocion.ValorDescuento);
        decimal descuento = promocion.TipoDescuento switch
        {
            "precio" => normal - Math.Min(normal, valor),
            "porcentaje" => normal * Math.Min(100, valor) / 100,
            _ => Math.Min(normal, valor)
        };
        descuento = Redondear(Math.Min(normal, descuento));
        return (normal, descuento, normal - descuento);
    }

    /// <summary>Calcula descuento total, IVA y total a partir del subtotal (sin descuento) y el descuento.</summary>
    public static (decimal Subtotal, decimal Descuento, decimal Iva, decimal Total) Totales(decimal subtotal, decimal descuento)
    {
        subtotal = Redondear(subtotal);
        descuento = Redondear(Math.Min(subtotal, descuento));
        var baseGravable = subtotal - descuento;
        var iva = Redondear(baseGravable * TasaIva);
        return (subtotal, descuento, iva, baseGravable + iva);
    }
}
