export default class MultiRoute extends HTMLElement {
   constructor(props) {
      super();
      this.props = props;
      this.renderedComponents = new Map(); // Cache para componentes renderizados
   }

   init() {
      if (!this.props.routes || !Array.isArray(this.props.routes)) {
         slice.logger.logError('MultiRoute', 'No valid routes array provided in props.');
         return;
      }
      // NOTE: MultiRoute does NOT register its routes in the Router. `routes.js` is the single
      // source of truth for what the Router knows. The Router resolves the URL on first load /
      // refresh / deep-link BEFORE this component mounts, so a path that only lived inside a
      // MultiRoute would 404 on a direct load — incoherent. Declare every section path in
      // `routes.js` (pointing at the shell); MultiRoute just chooses which one to show.
   }

   /**
    * Encuentra una ruta que coincida con el path actual
    * Soporta rutas estáticas y dinámicas con parámetros ${param}
    */
   matchRoute(currentPath) {
      // Normalize trailing slash so '/about/' behaves like '/about' (keep root '/').
      currentPath = currentPath.length > 1 ? currentPath.replace(/\/+$/, '') : currentPath;

      // 1. Match exacto, case-insensitive ('/About' coincide con '/about')
      const lowerPath = currentPath.toLowerCase();
      const exactMatch = this.props.routes.find(
         (route) => (route.path.length > 1 ? route.path.replace(/\/+$/, '') : route.path).toLowerCase() === lowerPath
      );
      if (exactMatch) {
         return { route: exactMatch, params: {} };
      }

      // 2. Si no hay match exacto, buscar rutas dinámicas
      for (const route of this.props.routes) {
         if (route.path.includes('${')) {
            const { regex, paramNames } = this.compilePathPattern(route.path);
            const match = currentPath.match(regex);
            
            if (match) {
               // Extraer parámetros de la URL
               const params = {};
               paramNames.forEach((name, i) => {
                  params[name] = match[i + 1];
               });
               
               return { route, params };
            }
         }
      }

      // 3. No se encontró ninguna ruta
      return { route: null, params: {} };
   }

   /**
    * Convierte un patrón de ruta con ${param} en una expresión regular
    * Ejemplo: "/user/${id}" -> /^\/user\/([^/]+)$/
    */
   compilePathPattern(pattern) {
      const paramNames = [];
      const regexPattern = '^' + pattern.replace(/\$\{([^}]+)\}/g, (_, paramName) => {
         paramNames.push(paramName);
         return '([^/]+)'; // Captura cualquier caracter excepto /
      }) + '$';

      return {
         // 'i': case-insensitive path matching. Captured param values keep their original case.
         regex: new RegExp(regexPattern, 'i'),
         paramNames
      };
   }

   async render() {
      const currentPath = window.location.pathname;
      const { route: routeMatch, params } = this.matchRoute(currentPath);

      if (routeMatch) {
         const { component, metadata } = routeMatch;

         if (this.renderedComponents.has(component)) {
            const cachedComponent = this.renderedComponents.get(component);
            this.innerHTML = '';

            // Actualizar props del componente cacheado
            if (cachedComponent.props) {
               cachedComponent.props = {
                  ...cachedComponent.props,
                  params: params,
                  metadata: metadata || {} // ✅ Incluir metadata
               };
            }

            // Si el componente en caché tiene un método update, lo ejecutamos
            if (cachedComponent.update) {
               await cachedComponent.update();
            }

            this.appendChild(cachedComponent);
         } else {
            if (!slice.controller.componentCategories.has(component)) {
               slice.logger.logError(`${this.sliceId}`, `Component ${component} not found`);
               return;
            }

            // Crear el componente con los parámetros y metadata de la ruta
            const newComponent = await slice.build(component, {
               params: params,
               metadata: metadata || {}
            });
            
            this.innerHTML = '';
            this.appendChild(newComponent);
            this.renderedComponents.set(component, newComponent);
         }

         // Emitir evento personalizado cuando el renderizado está completo
         this.dispatchEvent(new CustomEvent('route-rendered', {
            bubbles: true,
            detail: { 
               component, 
               path: currentPath,
               params: params,
               metadata: metadata || {} // ✅ Incluir metadata en el evento
            }
         }));
      } else {
         // Limpiamos el contenido si no hay una coincidencia de ruta
         this.innerHTML = '';
      }
   }

   async renderIfCurrentRoute() {
      const currentPath = window.location.pathname;
      const { route: routeMatch } = this.matchRoute(currentPath);

      if (routeMatch) {
         await this.render();
         return true;
      }
      return false;
   }

   removeComponent() {
      const currentPath = window.location.pathname;
      const { route: routeMatch } = this.matchRoute(currentPath);

      if (routeMatch) {
         const { component } = routeMatch;
         this.renderedComponents.delete(component);
         this.innerHTML = '';
      }
   }

   /**
    * Cleanup cuando el componente se destruye
    */
   destroy() {
      this.renderedComponents.clear();
      this.innerHTML = '';
   }
}

customElements.define('slice-multi-route', MultiRoute);
