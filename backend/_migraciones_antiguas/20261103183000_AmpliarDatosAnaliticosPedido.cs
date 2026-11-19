using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Infrastructure;
using GinnasPizza.Api.Data;

#nullable disable

namespace GinnasPizza.Api.Migrations
{
    [DbContext(typeof(AppDbContext))]
    [Migration("20261103183000_AmpliarDatosAnaliticosPedido")]
    public partial class AmpliarDatosAnaliticosPedido : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "EstadoPago",
                table: "Pedidos",
                type: "text",
                nullable: false,
                defaultValue: "Pendiente");
            migrationBuilder.AddColumn<string>(
                name: "TipoPedido",
                table: "Pedidos",
                type: "text",
                nullable: false,
                defaultValue: "Domicilio");
            migrationBuilder.AddColumn<string>(
                name: "MedioPago",
                table: "Pedidos",
                type: "text",
                nullable: false,
                defaultValue: "");
            migrationBuilder.AddColumn<string>(
                name: "Tamano",
                table: "DetallesPedido",
                type: "text",
                nullable: false,
                defaultValue: "");
            migrationBuilder.CreateIndex(
                name: "IX_Pedidos_Fecha",
                table: "Pedidos",
                column: "Fecha");
            migrationBuilder.CreateIndex(
                name: "IX_Pedidos_Estado_EstadoPago",
                table: "Pedidos",
                columns: new[] { "Estado", "EstadoPago" });
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Pedidos_Fecha",
                table: "Pedidos");
            migrationBuilder.DropIndex(
                name: "IX_Pedidos_Estado_EstadoPago",
                table: "Pedidos");
            migrationBuilder.DropColumn(name: "EstadoPago", table: "Pedidos");
            migrationBuilder.DropColumn(name: "TipoPedido", table: "Pedidos");
            migrationBuilder.DropColumn(name: "MedioPago", table: "Pedidos");
            migrationBuilder.DropColumn(name: "Tamano", table: "DetallesPedido");
        }
    }
}
