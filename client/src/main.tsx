
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './app/App';
import { AuthGate } from './auth/AuthGate';
import './styles/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AuthGate>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </AuthGate>
);
