export default class Link extends HTMLElement {
   constructor(props = {}) {
      super();
      this.props = props;
      this.render(props);
      this.init();
   }

   init() {
      this.addEventListener('click', this.onClick);
   }

   async onClick(event) {
      event.preventDefault();
      const path = this.querySelector('a')?.getAttribute('href');
      if (path) slice.router.navigate(path);
   }

   // Built with DOM APIs (setAttribute / textContent) instead of an innerHTML
   // template so a `path` like `javascript:...` or text containing markup can't
   // inject into the document.
   render(props = {}) {
      const { path = '#', classes = '', text = '' } = props;
      const anchor = document.createElement('a');
      anchor.setAttribute('href', path);
      anchor.setAttribute('data-route', '');
      if (classes) anchor.className = classes;
      anchor.textContent = text;
      this.replaceChildren(anchor);
   }
}

customElements.define('slice-link', Link);
