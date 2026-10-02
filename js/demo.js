// Petit projet fictif pour essayer l'application sans fournir de dossier.
const files = {
  'package.json': JSON.stringify({ name: 'demo-shop', dependencies: { react: '^18', 'react-i18next': '^14', axios: '^1' } }, null, 2),
  'tsconfig.json': `{
  // alias "@/..." -> src/
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } }
}`,
  'src/main.tsx': `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './i18n';
import '@/styles/global.scss';
createRoot(document.getElementById('root')!).render(<App />);`,
  'src/i18n.ts': `import i18n from 'i18next';
import fr from './locales/fr.json';
import en from './locales/en.json';
i18n.init({ resources: { fr: { translation: fr }, en: { translation: en } } });
export default i18n;`,
  'src/App.tsx': `import { LoginPage } from '@/pages/LoginPage';
import { CartPage } from '@/pages/CartPage';
import { Header } from '@/components/layout/Header';
export default function App() {
  return (<><Header /><LoginPage /><CartPage /></>);
}`,
  'src/pages/LoginPage.tsx': `import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { login } from '@/services/auth';
export function LoginPage() {
  const { t } = useTranslation();
  return (
    <form onSubmit={login}>
      <Input label={t('login.email')} />
      <Input label={t('login.password')} />
      <Button>{t('login.submit')}</Button>
      <Button variant="ghost">{t('login.cancel')}</Button>
    </form>
  );
}`,
  'src/pages/CartPage.tsx': `import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/Button';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { formatPrice } from '../utils/format';
export function CartPage() {
  const { t } = useTranslation();
  return (
    <div>
      <h1>{t('cart.title')}</h1>
      <p>{formatPrice(10)}</p>
      <Button>{t('cart.checkout')}</Button>
      <Button>Annuler</Button>
      <ConfirmModal />
    </div>
  );
}`,
  'src/pages/ProfilePage.tsx': `import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
export function ProfilePage() {
  const { t } = useTranslation();
  return (<><Input label={t('profile.emailLabel')} /><button>{t('profile.cancelButton')}</button><button>{t('profile.save')}</button></>);
}`,
  'src/components/ui/Button.tsx': `import './Button.scss';
export function Button(props) { return <button className="btn" {...props} />; }`,
  'src/components/ui/Button.scss': `@use '../../styles/variables';
.btn { color: variables.$primary; }`,
  'src/components/ui/Input.tsx': `import { validateEmail } from '../../utils/validators';
export function Input({ label }) { return <label>{label}<input onBlur={validateEmail} /></label>; }`,
  'src/components/layout/Header.tsx': `import { useTranslation } from 'react-i18next';
import { useCart } from '@/hooks/useCart';
export function Header() {
  const { t } = useTranslation();
  const cart = useCart();
  return <header>{t('header.title')} ({cart.count}) <a>{t('header.logout')}</a></header>;
}`,
  'src/components/modals/ConfirmModal.tsx': `import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
export function ConfirmModal() {
  const { t } = useTranslation();
  return <div role="dialog"><p>{t('modal.confirmText')}</p><Button>{t('modal.confirm')}</Button><Button>{t('modal.cancel')}</Button></div>;
}`,
  'src/components/modals/DeleteModal.tsx': `import { useTranslation } from 'react-i18next';
export function DeleteModal() {
  const { t } = useTranslation();
  return <div>{t(\`errors.\${'delete'}\`)}<button>{t('common.cancel')}</button></div>;
}`,
  'src/hooks/useCart.ts': `import { api } from '../services/api';
import { formatPrice } from '../utils/format';
export function useCart() { api.get('/cart'); return { count: 0, total: formatPrice(0) }; }`,
  'src/services/api.ts': `import axios from 'axios';
import { getToken } from './auth';
export const api = axios.create({ headers: { Authorization: getToken() } });`,
  'src/services/auth.ts': `import { api } from './api';
export function getToken() { return localStorage.getItem('token'); }
export function login() { return api.post('/login'); }`,
  'src/utils/format.ts': `export const formatPrice = (n: number) => n.toFixed(2) + ' €';`,
  'src/utils/validators.ts': `export const validateEmail = (s: string) => /@/.test(s);`,
  'src/helpers/format.ts': `export const formatPrice = (n: number) => n.toFixed(2) + ' €';`,
  'src/styles/variables.scss': `$primary: #3b5bdb;`,
  'src/styles/global.scss': `@use 'variables';
body { margin: 0; }`,
  'src/locales/fr.json': JSON.stringify({
    common: { cancel: 'Annuler', save: 'Enregistrer' },
    header: { title: 'Ma boutique', logout: 'Déconnexion' },
    login: { email: 'Email', password: 'Mot de passe', submit: 'Se connecter', cancel: 'Annuler' },
    profile: { emailLabel: 'E-mail', cancelButton: 'Annuler', save: 'Enregistrer' },
    cart: { title: 'Mon panier', checkout: 'Valider la commande', empty: 'Votre panier est vide' },
    modal: { confirmText: 'Êtes-vous sûr ?', confirm: 'Confirmer', cancel: 'annuler' },
    errors: { delete: 'Suppression impossible', required: 'Champ obligatoire' },
    newsletter: { email: 'Email :', subscribe: "S'abonner" },
  }, null, 2),
  'src/locales/en.json': JSON.stringify({
    common: { cancel: 'Cancel', save: 'Save' },
    header: { title: 'My shop', logout: 'Log out' },
    login: { email: 'Email', password: 'Password', submit: 'Sign in', cancel: 'Cancel' },
    profile: { emailLabel: 'E-mail', cancelButton: 'Cancel', save: 'Save' },
    cart: { title: 'My cart', checkout: 'Checkout', empty: 'Your cart is empty' },
    modal: { confirmText: 'Are you sure?', confirm: 'Confirm', cancel: 'Dismiss' },
    errors: { delete: 'Unable to delete', required: 'Required field' },
    newsletter: { email: 'Email:' },
  }, null, 2),
  'README.md': '# Demo shop\n',
  'public/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
};

export function demoEntries() {
  return Object.entries(files).map(([path, content]) => ({ path, content, size: content.length }));
}
