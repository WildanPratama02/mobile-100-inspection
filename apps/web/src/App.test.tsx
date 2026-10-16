import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders an empty main landmark', () => {
    render(<App />);
    expect(screen.getByRole('main')).toBeEmptyDOMElement();
  });
});
