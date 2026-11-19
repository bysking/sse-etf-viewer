import React, { useEffect, useRef } from 'react'
import { echarts } from '../researchChart.js'

/** 通用 ECharts 容器：研究页与 AI 页共用 */
export function EChart({ option, height = 620 }) {
  const ref = useRef(null)
  const inst = useRef(null)

  useEffect(() => {
    inst.current = echarts.init(ref.current)
    const onResize = () => inst.current?.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      inst.current?.dispose()
      inst.current = null
    }
  }, [])

  useEffect(() => {
    inst.current?.setOption(option, true)
  }, [option])

  return <div className="chart" style={{ height }} ref={ref} />
}
