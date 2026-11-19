using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GinnasPizza.Api.Migrations
{
    /// <inheritdoc />
    public partial class ImagenPromocion : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Imagen",
                table: "Promociones",
                type: "text",
                nullable: false,
                defaultValue: "");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Imagen",
                table: "Promociones");
        }
    }
}
