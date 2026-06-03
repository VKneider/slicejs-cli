export default class FetchManager {
   constructor(props) {
      const { baseUrl, timeout } = props;
      if (baseUrl !== undefined) {
         this.baseUrl = baseUrl;
      }
      this.methods = ['GET', 'POST', 'PUT', 'DELETE'];
      this.lastRequest = null;
      this.cacheEnabled = false;
      this.defaultHeaders = {};
      timeout ? (this.timeout = timeout) : (this.timeout = 10000);
   }

   async request(
      method,
      data,
      endpoint,
      onRequestSuccess,
      onRequestError,
      refetchOnError = false,
      requestOptions = {}
   ) {
      if (!this.methods.includes(method)) throw new Error('Invalid method');
      if (data && typeof data !== 'object') throw new Error('Invalid data, not JSON');
      const controller = new AbortController();

      let options;
      if (method !== 'GET') {
         options = {
            method: method,
            headers: {
               'Content-Type': 'application/json',
               ...this.defaultHeaders,
               ...requestOptions.headers,
            },
            signal: controller.signal,
         };
      } else {
         options = {
            method: method,
            headers: {
               ...this.defaultHeaders,
               ...requestOptions.headers,
            },
            signal: controller.signal,
         };
      }

      if (data) {
         options.body = JSON.stringify(data);
      }

      let loading;
      if (!slice.controller.getComponent('Loading')) {
         loading = await slice.build('Loading', { sliceId: 'Loading' });
      } else {
         loading = slice.controller.getComponent('Loading');
      }
      loading.start();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout || 10000);

      try {
         let response;

         // Check if cache is enabled and a cached response exists
         if (this.cacheEnabled && this.lastRequest && this.lastRequest.endpoint === endpoint) {
            loading.stop();
            return this.lastRequest.output;
         }

         if (this.baseUrl !== undefined) {
            response = await fetch(this.baseUrl + endpoint, options);
         } else {
            response = await fetch(endpoint, options);
         }

         if (response.ok) {
            if (typeof onRequestSuccess === 'function') {
               onRequestSuccess(data, response);
            }
         } else {
            if (typeof onRequestError === 'function') {
               onRequestError(data, response);
            }
            if (refetchOnError) {
               // Retry once on error; pass false to avoid infinite recursion when
               // the endpoint keeps failing.
               return await this.request(
                  method,
                  data,
                  endpoint,
                  onRequestSuccess,
                  onRequestError,
                  false,
                  requestOptions
               );
            }
         }

         let output = await response.json();
         loading.stop();

         // Cache the parsed response if cache is enabled
         if (this.cacheEnabled) {
            this.lastRequest = { data, output, endpoint };
         }

         return output;
      } catch (error) {
         // slice.logger.logError signature is (componentSliceId, message, error).
         if (error.message === 'Failed to fetch') {
            slice.logger.logError('FetchManager', 'Lost internet connection', error);
         } else {
            slice.logger.logError('FetchManager', 'Request failed', error);
         }
         loading.stop();
         throw error;
      } finally {
         clearTimeout(timeoutId);
      }
   }

   // Enable or disable caching of responses
   enableCache() {
      this.cacheEnabled = true;
   }

   disableCache() {
      this.cacheEnabled = false;
   }

   // Set default headers for all requests
   setDefaultHeaders(headers) {
      this.defaultHeaders = headers;
   }
}
