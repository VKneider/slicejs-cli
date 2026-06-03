// Warns once per deprecated prop name (kept module-scoped so each component
// reports a given alias only once per session).
const _sliceDeprecated = new Set();
function deprecate(oldName, newName) {
   if (_sliceDeprecated.has(oldName)) return;
   _sliceDeprecated.add(oldName);
   console.warn(`[Slice] "${oldName}" is deprecated; use "${newName}" instead.`);
}

export default class Loading extends HTMLElement {

   static props = {
      // Canonical busy-state flag. `isActive` is kept as a deprecated alias.
      active: {
         type: 'boolean',
         default: false,
         required: false
      },
      isActive: {
         type: 'boolean',
         default: false,
         required: false
      },
      container: {
         type: 'object',
         default: null,
         required: false
      }
   };

   constructor(props) {
      super();
      slice.attachTemplate(this);
      slice.controller.setComponentProps(this, props);
      this._container = this.container || null;
      this._isActive = false;
      this._currentContainer = null;
   }

   init() {}

   /**
    * Muestra el loading spinner
    * @param {HTMLElement} container - Opcional. Contenedor donde mostrar el loading.
    *                                  Si no se proporciona, usa document.body (fullscreen)
    */
   start(container = null) {
      // Determinar el contenedor
      const targetContainer = container || this._container || document.body;
      
      // Si ya está activo en el mismo container, no hacer nada
      if (this._isActive && this._currentContainer === targetContainer) {
         return;
      }
      
      // Si está activo en otro container, primero detenerlo
      if (this._isActive) {
         this.stop();
      }
      
      // Configurar estilos según el contenedor
      if (targetContainer !== document.body) {
         // Para contenedores específicos
         // Guardar el position original para restaurarlo después
         this._originalPosition = targetContainer.style.position;
         this._originalOverflow = targetContainer.style.overflow;
         
         // Solo cambiar si no tiene position definido o es static
         const currentPosition = window.getComputedStyle(targetContainer).position;
         if (currentPosition === 'static' || currentPosition === '') {
            targetContainer.style.position = 'relative';
         }
         
         // Ocultar overflow para que el loading no se salga
         targetContainer.style.overflow = 'hidden';
         
         // Configurar el loading como absolute para que llene el container
         this.style.position = 'absolute';
         this.style.top = '0';
         this.style.left = '0';
         this.style.right = '0';
         this.style.bottom = '0';
         this.style.width = '100%';
         this.style.height = '100%';
      } else {
         // Para document.body (fullscreen)
         this.style.position = 'fixed';
         this.style.top = '0';
         this.style.left = '0';
         this.style.right = '0';
         this.style.bottom = '0';
         this.style.width = '100%';
         this.style.height = '100%';
      }
      
      // Append al contenedor
      targetContainer.appendChild(this);
      this._isActive = true;
      this._currentContainer = targetContainer;
   }

   /**
    * Oculta el loading spinner
    */
   stop() {
      if (!this._isActive) {
         return;
      }
      
      // Restaurar estilos originales del container si los modificamos
      if (this._currentContainer && 
          this._currentContainer !== document.body) {
         if (this._originalPosition !== undefined) {
            this._currentContainer.style.position = this._originalPosition;
         }
         if (this._originalOverflow !== undefined) {
            this._currentContainer.style.overflow = this._originalOverflow;
         }
      }
      
      // Remover del DOM
      if (this.parentNode) {
         this.parentNode.removeChild(this);
      }
      
      this._isActive = false;
      this._currentContainer = null;
      this._originalPosition = undefined;
      this._originalOverflow = undefined;
   }

   // Canonical busy-state flag. Toggling it shows/hides the spinner.
   get active() {
      return this._isActive;
   }

   set active(value) {
      if (value === true && !this._isActive) {
         this.start();
      } else if (value === false && this._isActive) {
         this.stop();
      }
   }

   // Deprecated alias for `active`.
   get isActive() {
      return this._isActive;
   }

   set isActive(value) {
      if (value) deprecate('isActive', 'active');
      this.active = value;
   }

   get container() {
      return this._container;
   }

   set container(value) {
      this._container = value;
   }
}

customElements.define('slice-loading', Loading);