import { Context } from '@koishijs/client'
import Qzone from './qzone.vue'

export default (ctx: Context) => {
  ctx.page({
    path: '/qzone',
    name: 'QQ 空间互动',
    desc: '查看登录态、自动互动、重试队列并发布空间动态',
    icon: 'paper-plane',
    position: 'bottom',
    order: 588,
    authority: 4,
    component: Qzone
  })
}
