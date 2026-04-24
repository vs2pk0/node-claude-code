import { createApp } from 'vue'
import Antd from 'ant-design-vue'
import 'ant-design-vue/dist/reset.css'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { initApiBaseUrl } from './desktop'

async function bootstrap() {
  await initApiBaseUrl()
  createApp(App).use(router).use(Antd).mount('#app')
}

void bootstrap()
