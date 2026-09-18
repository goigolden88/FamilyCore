import { NavLink, Outlet } from 'react-router-dom'
import { ScrollButtons } from './ScrollButtons.tsx'

/** Вкладка нижней панели: адрес, подпись, совпадение адреса целиком. */
export type Tab = { to: string; name: string; end: boolean }

/**
 * Нижняя панель: только то, что открывают каждый день. Вкладки прибавляются
 * вместе с экранами, по этапам.
 *
 * «Настроек» здесь нет намеренно, как и в «Дневниках»: в них заходят раз
 * в месяц, и живут они шестерёнкой в шапке главного экрана.
 *
 * Список вкладок — приложения (Р-16, Р-48 «Трапезы»): адреса и подписи у
 * каждого свои, у «Делу Время» подписи ещё и настройка устройства
 * (Р-26 «Делу Время»). Ядро рисует то, что дали.
 */
export function Layout({ tabs }: { tabs: readonly Tab[] }) {
  return (
    <div className="layout">
      <main className="content">
        <Outlet />
      </main>

      {/* «В начало» и «в конец» (Р-70 «Делу Время»): видны, пока экран листают. */}
      <ScrollButtons />

      <nav className="tabs">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => (isActive ? 'tab tab--active' : 'tab')}
          >
            {tab.name}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
