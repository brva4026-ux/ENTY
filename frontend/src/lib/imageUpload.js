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
 * @param {File} file imagen elegida por la persona
 * @param {{maxSide?: number, quality?: number}} opts lado mayor maximo en px y
 *   calidad JPEG (0-1). Default 900px / 0.82, que es lo que usa el flyer.
 * @returns {Promise<string>} data-URL `data:image/jpeg;base64,...`
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
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
