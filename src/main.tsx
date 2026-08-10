import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import DigitalHumanPage from './features/digital-human/DigitalHumanPage'
import './styles.css'
import './features/digital-human/digital-human.css'

// 真人数字人工作台通过 ?view=digital-human 顶层分发，不进入漫剧五阶段工作台。
const isDigitalHuman = new URLSearchParams(window.location.search).get('view') === 'digital-human'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isDigitalHuman ? <DigitalHumanPage /> : <App />}
  </StrictMode>,
)
