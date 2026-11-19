namespace GinnasPizza.Api.Contracts;

/// <summary>
/// Disponibilidad de un producto (y tamaño, en pizzas) según su receta y el stock actual.
/// <c>Size</c> está vacío para productos que no tienen tamaños.
/// </summary>
public sealed record ProductAvailabilityResponse(
    int ProductId,
    string Size,
    bool Available,
    string Status,
    string Reason,
    int? MaximumQuantity);
