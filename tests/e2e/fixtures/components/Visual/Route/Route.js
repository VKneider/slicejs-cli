export default class Route extends HTMLElement {
   constructor(props) {
      super();
      this.props = props;
      this.rendered = false;
   }

   init() {
      if (!this.props.path) {
         this.props.path = ' ';
      }

      // If no component is given, derive it from routes.js (the Router's pathToRouteMap).
      if (!this.props.component) {
         this.props.component = slice.router.pathToRouteMap.get(this.props.path)?.component || ' ';
      }
      // NOTE: Route does NOT register itself in the Router. `routes.js` is the single source of
      // truth for what the Router knows. The Router resolves the URL on first load / refresh /
      // deep-link BEFORE this component mounts, so a path that only lived in a Route would 404
      // on a direct load. Declare every path in `routes.js`.
   }

   get path() {
      return this.props.path;
   }

   set path(value) {
      this.props.path = value;
   }

   get component() {
      return this.props.component;
   }

   set component(value) {
      this.props.component = value;
   }

   /**
    * Verifica si el path actual coincide con el path del Route
    * Soporta rutas estáticas y dinámicas con parámetros ${param}
    */
   matchesCurrentPath() {
      // Normalize trailing slash so '/about/' behaves like '/about' (keep root '/').
      const raw = window.location.pathname;
      const currentPath = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
      const routePath = this.props.path.length > 1 ? this.props.path.replace(/\/+$/, '') : this.props.path;

      // 1. Match exacto, case-insensitive ('/About' coincide con '/about')
      if (routePath.toLowerCase() === currentPath.toLowerCase()) {
         return { matches: true, params: {} };
      }

      // 2. Si la ruta tiene parámetros dinámicos ${param}
      if (this.props.path.includes('${')) {
         const { regex, paramNames } = this.compilePathPattern(this.props.path);
         const match = currentPath.match(regex);
         
         if (match) {
            // Extraer parámetros de la URL
            const params = {};
            paramNames.forEach((name, i) => {
               params[name] = match[i + 1];
            });
            
            return { matches: true, params };
         }
      }

      return { matches: false, params: {} };
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

   async render(params = {}) {
      const metadata = this.props.metadata || {};

      if (Route.componentCache[this.props.component]) {
         const cachedComponent = Route.componentCache[this.props.component];
         this.innerHTML = '';

         // Actualizar props del componente cacheado
         if (cachedComponent.props) {
            cachedComponent.props = {
               ...cachedComponent.props,
               params: params,
               metadata: metadata // ✅ Incluir metadata
            };
         }

         if (cachedComponent.update) {
            await cachedComponent.update();
         }

         this.appendChild(cachedComponent);
      } else {
         if (!this.props.component) {
            return;
         }

         if (!slice.controller.componentCategories.has(this.props.component)) {
            slice.logger.logError(`${this.sliceId}`, `Component ${this.props.component} not found`);
            return;
         }

         // Crear el componente con los parámetros y metadata de la ruta
         const component = await slice.build(this.props.component, {
            sliceId: this.props.component,
            params: params, // ✅ Pasar los parámetros al componente
            metadata: metadata // ✅ Pasar metadata al componente
         });

         this.innerHTML = '';
         this.appendChild(component);
         Route.componentCache[this.props.component] = component;
      }
      this.rendered = true;
   }

   async renderIfCurrentRoute() {
      const { matches, params } = this.matchesCurrentPath();
      
      if (matches) {
         if (this.rendered) {
            if (Route.componentCache[this.props.component]) {
               const cachedComponent = Route.componentCache[this.props.component];
               
               // Actualizar params y metadata en el componente cacheado
               if (cachedComponent.props) {
                  cachedComponent.props = {
                     ...cachedComponent.props,
                     params: params,
                     metadata: this.props.metadata || {}
                  };
               }

               if (cachedComponent.update) {
                  await cachedComponent.update();
               }
               return true;
            }
         }
         await this.render(params);
         return true;
      }
      return false;
   }

   removeComponent() {
      delete Route.componentCache[this.props.component];
      this.innerHTML = '';
      this.rendered = false;
   }

   /**
    * Cleanup cuando el componente se destruye
    */
   destroy() {
      this.removeComponent();
   }
}

Route.componentCache = {};

customElements.define('slice-route', Route);