/**
 * Данные ленты: все хранилища разом. Взято из «Дневников».
 *
 * Лента только читает, поэтому общего состояния с модулями ей не нужно:
 * она берёт слепок базы и перечитывает его на любое изменение — своё,
 * чужое, из файла. Слепок, а не выборка по хранилищу: он отдаёт записи
 * вместе с надгробиями, а без них у блока удалённой категории не было бы
 * имени.
 *
 * Строки собирает приложение — `feedItems` его `registry.ts` приходит
 * аргументом (Я-03): ядро про виды записей не знает.
 */

import { useEffect, useMemo, useState } from 'react'
import { today, type DateStr } from '../core/dates.ts'
import type { StoreData } from '../core/db.ts'
import type { FeedItem } from '../core/feed.ts'
import type { StoreMap } from '../core/model.ts'
import { useCore } from '../ui/core.tsx'

export type Feed = {
  status: 'loading' | 'ready' | 'failed'
  error: string
  items: FeedItem[]
}

/** Строки ленты по всем данным приложения на день `day`. */
export type FeedBuilder<R extends StoreMap> = (data: StoreData<R>, day: DateStr) => FeedItem[]

export function useFeed<R extends StoreMap>(feedItems: FeedBuilder<R>): Feed {
  const { db } = useCore()
  const [data, setData] = useState<StoreData<R> | null>(null)
  const [error, setError] = useState('')
  const [day, setDay] = useState<DateStr>(today())

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        await db.ready()
        const snapshot = await db.exportAll()
        // Слепок базы приложения — той самой, чьи хранилища знает `feedItems`.
        if (!cancelled) setData(snapshot.data as StoreData<R>)
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Неизвестная ошибка')
      }
    }

    void load()
    const unsubscribe = db.onChange(() => void load())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [db])

  // Строки вправе зависеть от сегодняшнего дня, а вкладка установленного
  // приложения неделями не перезапускается.
  useEffect(() => {
    function refreshDay() {
      if (document.visibilityState === 'visible') setDay(today())
    }
    document.addEventListener('visibilitychange', refreshDay)
    return () => document.removeEventListener('visibilitychange', refreshDay)
  }, [])

  const items = useMemo(() => (data ? feedItems(data, day) : []), [data, day, feedItems])

  return {
    status: error ? 'failed' : data ? 'ready' : 'loading',
    error,
    items,
  }
}
