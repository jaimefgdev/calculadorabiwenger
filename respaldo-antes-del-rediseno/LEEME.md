# Como estaba todo antes del rediseno

Copia literal de los cuatro archivos que hacen la web, tal y como estaban el
14 de septiembre de 2026, justo antes de empezar a darle el estilo de la app
de Biwenger.

    app.js      v521
    styles.css  v518
    index.html
    sw.js       calc-v121

## Para volver

Lo mas comodo, con git:

    git checkout antes-del-rediseno -- app.js styles.css index.html sw.js

O a mano, copiando los cuatro archivos de esta carpeta a la de arriba.

En los dos casos, despues hay que subir el `?v=` de `index.html` y la
`VERSION` de `sw.js` para que los navegadores se bajen los archivos otra vez
en vez de servir los del rediseno, que ya tendran guardados.

## Que NO hace falta respaldar

El proxy (`deno/biwenger-proxy.js`) no se toca en el rediseno: solo cambia
como se ve la web, no de donde salen los datos.
