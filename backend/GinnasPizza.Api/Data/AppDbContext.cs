using GinnasPizza.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Data;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options)
        : base(options)
    {
    }

    public DbSet<Producto> Productos => Set<Producto>();

    public DbSet<Cliente> Clientes => Set<Cliente>();

    public DbSet<Pedido> Pedidos => Set<Pedido>();

    public DbSet<DetallePedido> DetallesPedido => Set<DetallePedido>();

    public DbSet<Venta> Ventas => Set<Venta>();

    public DbSet<Ingrediente> Ingredientes => Set<Ingrediente>();

    public DbSet<Proveedor> Proveedores => Set<Proveedor>();

    public DbSet<MovimientoInventario> MovimientosInventario => Set<MovimientoInventario>();

    public DbSet<Receta> Recetas => Set<Receta>();

    public DbSet<Usuario> Usuarios => Set<Usuario>();

    public DbSet<Promocion> Promociones => Set<Promocion>();

    public DbSet<PromocionComponente> PromocionComponentes => Set<PromocionComponente>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<Usuario>(e =>
        {
            e.HasIndex(x => x.Correo).IsUnique();
            e.Property(x => x.Nombre).HasMaxLength(120);
            e.Property(x => x.Correo).HasMaxLength(160);
            e.Property(x => x.Rol).HasMaxLength(30);
        });

        modelBuilder.Entity<Cliente>(e =>
        {
            // Los clientes de mostrador pueden no tener correo; solo se exige unicidad cuando existe.
            e.HasIndex(x => x.Correo).IsUnique().HasFilter("\"Correo\" <> ''");
            e.Property(x => x.Nombre).HasMaxLength(120);
            e.Property(x => x.Correo).HasMaxLength(160);
        });

        modelBuilder.Entity<Producto>(e =>
        {
            e.HasIndex(x => x.Nombre).IsUnique();
            e.Property(x => x.Nombre).HasMaxLength(100);
            e.Property(x => x.Categoria).HasMaxLength(30);
            e.Property(x => x.Precio).HasPrecision(18, 2);
            e.Property(x => x.PrecioMediana).HasPrecision(18, 2);
            e.Property(x => x.PrecioFamiliar).HasPrecision(18, 2);
        });

        modelBuilder.Entity<Proveedor>(e =>
        {
            e.Property(x => x.Nombre).HasMaxLength(120);
        });

        modelBuilder.Entity<Ingrediente>(e =>
        {
            e.HasIndex(x => x.Nombre).IsUnique();
            e.Property(x => x.Nombre).HasMaxLength(100);
            e.Property(x => x.StockActual).HasPrecision(18, 4);
            e.Property(x => x.StockMinimo).HasPrecision(18, 4);
            e.Property(x => x.CostoUnitario).HasPrecision(18, 2);
            e.HasOne(x => x.Proveedor).WithMany().HasForeignKey(x => x.ProveedorId).OnDelete(DeleteBehavior.SetNull);
            // xmin (columna de sistema de PostgreSQL) como token de concurrencia optimista:
            // evita que dos pedidos simultáneos descuenten el mismo stock dos veces.
            e.Property(x => x.Version)
                .HasColumnName("xmin")
                .HasColumnType("xid")
                .ValueGeneratedOnAddOrUpdate()
                .IsConcurrencyToken();
        });

        modelBuilder.Entity<Receta>(e =>
        {
            e.HasIndex(x => new { x.ProductoId, x.Tamano, x.IngredienteId }).IsUnique();
            e.Property(x => x.Tamano).HasMaxLength(20);
            e.Property(x => x.Cantidad).HasPrecision(18, 4);
            e.HasOne(x => x.Producto).WithMany(p => p.Recetas).HasForeignKey(x => x.ProductoId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Ingrediente).WithMany().HasForeignKey(x => x.IngredienteId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<MovimientoInventario>(e =>
        {
            e.HasIndex(x => x.Fecha);
            e.HasIndex(x => x.PedidoId);
            e.Property(x => x.Tipo).HasMaxLength(20);
            e.Property(x => x.Cantidad).HasPrecision(18, 4);
            e.HasOne(x => x.Ingrediente).WithMany().HasForeignKey(x => x.IngredienteId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Pedido).WithMany().HasForeignKey(x => x.PedidoId).OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<Pedido>(e =>
        {
            e.HasIndex(x => x.Fecha).HasDatabaseName("IX_Pedidos_Fecha");
            e.HasIndex(x => new { x.Estado, x.EstadoPago }).HasDatabaseName("IX_Pedidos_Estado_EstadoPago");
            e.Property(x => x.Subtotal).HasPrecision(18, 2);
            e.Property(x => x.Descuento).HasPrecision(18, 2);
            e.Property(x => x.Iva).HasPrecision(18, 2);
            e.Property(x => x.Total).HasPrecision(18, 2);
            e.HasOne(x => x.Cliente).WithMany(c => c.Pedidos).HasForeignKey(x => x.ClienteId).OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<DetallePedido>(e =>
        {
            e.Property(x => x.PrecioNormalUnitario).HasPrecision(18, 2);
            e.Property(x => x.DescuentoUnitario).HasPrecision(18, 2);
            e.Property(x => x.PrecioUnitario).HasPrecision(18, 2);
            e.Property(x => x.Subtotal).HasPrecision(18, 2);
            e.HasOne(x => x.Pedido).WithMany(p => p.Detalles).HasForeignKey(x => x.PedidoId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Producto).WithMany().HasForeignKey(x => x.ProductoId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Promocion).WithMany().HasForeignKey(x => x.PromocionId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<Venta>(e =>
        {
            e.HasIndex(x => x.PedidoId).IsUnique();
            e.HasIndex(x => x.Fecha);
            e.Property(x => x.Subtotal).HasPrecision(18, 2);
            e.Property(x => x.Descuento).HasPrecision(18, 2);
            e.Property(x => x.Iva).HasPrecision(18, 2);
            e.Property(x => x.Total).HasPrecision(18, 2);
            e.HasOne(x => x.Pedido).WithOne(p => p.Venta).HasForeignKey<Venta>(x => x.PedidoId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<Promocion>(e =>
        {
            e.HasIndex(x => x.Nombre).IsUnique();
            e.Property(x => x.Nombre).HasMaxLength(80);
            e.Property(x => x.ValorDescuento).HasPrecision(18, 2);
        });

        modelBuilder.Entity<PromocionComponente>(e =>
        {
            e.HasOne(x => x.Promocion).WithMany(p => p.Componentes).HasForeignKey(x => x.PromocionId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Producto).WithMany().HasForeignKey(x => x.ProductoId).OnDelete(DeleteBehavior.Restrict);
        });
    }
}
