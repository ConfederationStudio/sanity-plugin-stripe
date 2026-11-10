import {defineArrayMember, defineField, defineType} from 'sanity'

/** Something the test shop sells. The plugin adds the `stripeCommerce` type; the rest is the site's. */
export const product = defineType({
  name: 'product',
  type: 'document',
  fields: [
    defineField({name: 'title', type: 'string', validation: (rule) => rule.required()}),
    defineField({
      name: 'slug',
      type: 'slug',
      options: {source: 'title'},
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'images',
      type: 'array',
      of: [defineArrayMember({type: 'image'})],
    }),
    defineField({name: 'description', type: 'text', rows: 4}),
    defineField({name: 'commerce', title: 'Price and stock', type: 'stripeCommerce'}),
  ],
  preview: {
    select: {
      title: 'title',
      price: 'commerce.price',
      availability: 'commerce.availability',
      media: 'images.0',
    },
    prepare: ({title, price, availability, media}) => ({
      title,
      subtitle:
        availability === 'soldOut'
          ? 'Sold out'
          : typeof price === 'number'
            ? `€${price.toFixed(2)}`
            : 'No price',
      media,
    }),
  },
})
