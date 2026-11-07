import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ChakraProvider, defaultSystem } from '@chakra-ui/react'
import { Provider, createStore } from 'jotai'
import App from './App.jsx'
import { bootstrap } from './bootstrap.js'
import { followDeviceColorMode } from './colorMode.js'

// ライト/ダークは端末の設定に従う (変更にも追従)
followDeviceColorMode()

const store = createStore()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ChakraProvider value={defaultSystem}>
      <Provider store={store}>
        <App />
      </Provider>
    </ChakraProvider>
  </StrictMode>,
)

// React の外で一度だけ起動 (StrictMode の二重実行を避ける)
bootstrap(store)
