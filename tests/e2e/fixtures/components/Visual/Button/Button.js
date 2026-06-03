// Warns once per deprecated prop name (kept module-scoped so each component
// reports a given alias only once per session).
const _sliceDeprecated = new Set();
function deprecate(oldName, newName) {
   if (_sliceDeprecated.has(oldName)) return;
   _sliceDeprecated.add(oldName);
   console.warn(`[Slice] "${oldName}" is deprecated; use "${newName}" instead.`);
}

export default class Button extends HTMLElement {

   static props = {
      value: {
         type: 'string',
         default: 'Button',
         required: false
      },
      // Visual style, all derived from theme tokens. `filled` preserves the
      // original solid look.
      variant: {
         type: 'string',
         default: 'filled',
         required: false,
         allowedValues: ['filled', 'outlined', 'ghost', 'soft']
      },
      // Canonical click handler. `onClickCallback` is kept as a deprecated alias.
      onClick: {
         type: 'function',
         default: null
      },
      onClickCallback: {
         type: 'function',
         default: null
      },
      customColor: {
         type: 'object',
         default: null
      },
      icon: {
         type: 'object',
         default: null
      }
   };

   constructor(props) {
      super();
      slice.attachTemplate(this);
      this.$value = this.querySelector('.slice_button_value');
      this.$button = this.querySelector('.slice_button');
      this.$container = this.querySelector('.slice_button_container');

      // type="button" prevents accidental form submission when used inside a form.
      this.$button.setAttribute('type', 'button');

      // Listener is attached unconditionally; the handler is resolved at click
      // time so it works whether it arrived via onClick or the legacy alias.
      this.$container.addEventListener('click', async () => {
         if (this._onClick) await this._onClick();
      });

      slice.controller.setComponentProps(this, props);
   }

   async init() {
      if (this.icon) {
         this.$icon = await slice.build('Icon', {
            name: this.icon.name,
            iconStyle: this.icon.iconStyle,
            size: '20px',
            color: 'currentColor',
         });
         this.$button.insertBefore(this.$icon, this.$value);
      }
   }

   get onClick() {
      return this._onClick;
   }

   set onClick(value) {
      if (typeof value === 'function') this._onClick = value;
   }

   // Deprecated alias for onClick.
   set onClickCallback(value) {
      if (typeof value === 'function') {
         this._onClick ??= value;
         deprecate('onClickCallback', 'onClick');
      }
   }

   get icon() {
      return this._icon;
   }

   set icon(value) {
      this._icon = value;
      if (!this.$icon) return;
      this.$icon.name = value.name;
      this.$icon.iconStyle = value.iconStyle;
   }

   get variant() {
      return this._variant;
   }

   set variant(value) {
      const allowed = ['filled', 'outlined', 'ghost', 'soft'];
      const next = allowed.includes(value) ? value : 'filled';
      if (this._variant) {
         this.$button.classList.remove('slice_button--' + this._variant);
      }
      this._variant = next;
      this.$button.classList.add('slice_button--' + next);
   }

   get value() {
      return this._value;
   }

   set value(value) {
      this._value = value;
      this.$value.textContent = value;
      // Keep an accessible name even for icon-only buttons.
      if (value) this.$button.setAttribute('aria-label', value);
   }

   get customColor() {
      return this._customColor;
   }

   // Canonical shape: { background, text }. Legacy { button, label } still works.
   set customColor(value) {
      this._customColor = value;
      if (!value) return;

      if (value.button || value.label) {
         deprecate('customColor { button, label }', 'customColor { background, text }');
      }

      const background = value.background ?? value.button;
      const text = value.text ?? value.label;

      if (background) {
         this.$button.style.backgroundColor = background;
         this.$button.style.borderColor = background;
      }
      if (text) {
         this.$button.style.color = text;
         this.$value.style.color = text;
         if (this.$icon) {
            this.$icon.style.color = text;
         }
      }
   }
}

customElements.define('slice-button', Button);
