/**
 * Reduce una imagen en el navegador y la devuelve como data-URL lista para
 * subir a `media` (POST /venues/{id}/media o /auth/avatar).
 *
 * Por que existe:
 *   * El backend acepta data-URL JSON, no multipart: menos superficie y menos
 *     dependencias en la funcion serverless. Un data-URL de una foto de camara
 *     sin reducir son varios MB de base64 y roza el limite de payload.
 *   * El limite duro de `media` es 600 KB ya decodificados y el canvas deja la
 *     imagen en decenas de KB. Reducir en el cliente no es optimizar: es lo que
 *     hace que la subida funcione.
 *
 * Sin librerias: FileReader + canvas nativo.
 *
 * Formato: se prefiere WebP (el backend y el CHECK de la DB ya lo aceptan) y se
 * cae a JPEG solo si el navegador no sabe codificarlo. Un flyer de 900px pesa
 * ~30% menos en WebP con la misma calidad percibida, y ese ahorro lo paga el
 * invitado en su plan de datos cada vez que abre la vitrina.
 *
 * @param {File} file imagen elegida por la persona
 * @param {{maxSide?: number, quality?: number}} opts lado mayor maximo en px y
 *   calidad (0-1). Default 900px / 0.82, que es lo que usa el flyer.
 * @returns {Promise<string>} data-URL `data:image/webp;base64,...` (o jpeg).
 */
export function fileToDataUrl(file, { maxSide = 900, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("El archivo no es una imagen válida."));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas
          .getContext("2d")
          .drawImage(img, 0, 0, canvas.width, canvas.height);
        // Safari <14 y navegadores viejos devuelven un data-URL PNG cuando el
        // tipo pedido no está soportado (no lanzan): por eso se verifica el
        // prefijo real en vez de confiar en el pedido.
        const webp = canvas.toDataURL("image/webp", quality);
        if (webp.startsWith("data:image/webp")) {
          resolve(webp);
          return;
        }
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
