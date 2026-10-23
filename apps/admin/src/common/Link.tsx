import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { navigate } from '../app/router';

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

/** An in-app `<a>`: a plain click navigates without a reload; a modified click opens a new tab as usual. */
export function Link({ href, onClick, ...rest }: LinkProps) {
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={click} {...rest} />;
}
