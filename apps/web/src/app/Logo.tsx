import logoUrl from '../assets/parkland.png';
import './app.css';

export interface LogoProps {
  /** Where it sits; each placement has its height in CSS (doc 05 §4a), never below 32 px. */
  placement: 'start' | 'login' | 'home' | 'menu';
  /** Only the login screen names the logo; elsewhere it is decorative. */
  alt?: string;
}

/** The PT Parkland World Indonesia mark, used as is: never redrawn, recoloured or stretched. */
export function Logo({ placement, alt = '' }: LogoProps) {
  return <img src={logoUrl} alt={alt} className={`app-logo app-logo--${placement}`} />;
}
