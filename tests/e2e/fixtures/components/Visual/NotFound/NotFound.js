export default class NotFound extends HTMLElement {

   static props = {
      // No props needed for this component
   };

   constructor(props) {
      super();
      slice.attachTemplate(this);

      slice.controller.setComponentProps(this, props);
   }

   init() {
      //change title of the page
      document.title = '404 - Not Found';
   }
}

customElements.define('slice-notfound', NotFound);
