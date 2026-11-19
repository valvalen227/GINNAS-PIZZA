namespace GinnasPizza.Api.Models;

public class Proveedor
{
    public int Id { get; set; }

    public string Nombre { get; set; } = string.Empty;

    public string Empresa { get; set; } = string.Empty;

    public string Identificacion { get; set; } = string.Empty;

    public string Contacto { get; set; } = string.Empty;

    public string Telefono { get; set; } = string.Empty;

    public string Correo { get; set; } = string.Empty;

    public string Direccion { get; set; } = string.Empty;

    /// <summary>Descripción libre de lo que suministra.</summary>
    public string Productos { get; set; } = string.Empty;

    public string Observaciones { get; set; } = string.Empty;

    public bool Activo { get; set; } = true;
}
