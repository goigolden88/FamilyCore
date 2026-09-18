import { NavLink, Outlet } from 'react-router-dom'
import type { ScreenKey } from './screenNames.ts'
import { ScrollButtons } from './ScrollButtons.tsx'
import { useScreenNames } from './useScreenNames.ts'

/**
 * Нижняя панель: только то, что открывают каждый день. Вкладки прибавляются
 * вместе с экранами, по этапам.
 *
 * «Настроек» здесь нет намеренно, как и в «Дневниках»: в них заходят раз
 * в месяц, и живут они шестерёнкой в шапке «Сегодня».
 */
const TABS: readonly { to: string; screen: ScreenKey; end: boolean }[] = [
  { to: '/', screen: 'today', end: true },
  { to: '/time', screen: 'time', end: false },
  { to: '/inbox', screen: 'inbox', end: false },
]

export function Layout() {
  // Подписи — из настроек устройства (Р-26), адреса — постоянные.
  const names = useScreenNames()

  return (
    <div className="layout">
      <main className="content">
        <Outlet />
      </main>

      {/* «В начало» и «в конец» (Р-70): видны, пока экран листают. */}
      <ScrollButtons />

      <nav className="tabs">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => (isActive ? 'tab tab--active' : 'tab')}
          >
            {names[tab.screen]}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
