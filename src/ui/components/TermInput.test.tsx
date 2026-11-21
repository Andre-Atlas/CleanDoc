import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { TermInput } from './index';

function Harness({ initial = [] as string[] }) {
  const [t, setT] = useState(initial);
  return <TermInput label="Nomes de pessoas" terms={t} onChange={setT} />;
}

describe('TermInput', () => {
  it('Enter e vírgula criam chips; sem duplicatas', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Nomes de pessoas');
    await userEvent.type(input, 'João da Silva{Enter}Maria Oliveira,joão da silva{Enter}');
    expect(screen.getByRole('button', { name: 'Remover João da Silva' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remover Maria Oliveira' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Remover/ })).toHaveLength(2);
    expect(screen.getByText('2 termos')).toBeInTheDocument();
  });
  it('colar uma lista cria vários chips', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Nomes de pessoas');
    input.focus();
    await userEvent.paste('Ana\nBeto\nCaio');
    expect(screen.getAllByRole('button', { name: /^Remover/ })).toHaveLength(3);
  });
  it('Backspace no campo vazio remove o último; × remove o escolhido', async () => {
    render(<Harness initial={['Ana', 'Beto']} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover Ana' }));
    expect(screen.queryByText('Ana')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Nomes de pessoas'), '{Backspace}');
    expect(screen.queryByText('Beto')).not.toBeInTheDocument();
  });
});
