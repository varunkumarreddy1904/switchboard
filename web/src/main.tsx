import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastHost } from './components/ui'
import { Console } from './Console'
import { stream } from './lib/api'
import './styles.css'

try {
  const t = new URLSearchParams(location.search).get('theme') ?? localStorage.getItem('theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch {
  /* storage unavailable */
}

stream.start()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastHost>
      <Console />
    </ToastHost>
  </StrictMode>,
)
